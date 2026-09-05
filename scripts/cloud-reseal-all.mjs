// 기존 클라우드 회사 데이터 서버 일괄 재봉인 — 평문으로 올라가 있던 객체를 소유자 계정 키(v2 봉투)로 덮어쓴다.
// 대상 = 각 회사 __manifest__.json에 실린 rel만: 리스(_device-lease.json)·클레임·툼스톤 같은 제어 객체는 동기화가 봉투 개봉 없이 직접 파싱하므로
// 매니페스트 밖이라 자동 제외된다. 회사 파일 재봉인이 전부 성공하면 매니페스트도 같은 키로 봉인한다(#437 검수 HIGH-2: 파일 v2 + 매니페스트 평문
// 혼합을 남기면 ≤v0.1.23 클라이언트가 암호문을 노트로 기록한다 — v2 매니페스트면 그 버전은 파싱 실패로 보류).
// 동시 push 유실 창(#437 검수 HIGH-3, Storage에 CAS 없음)은 네 겹으로 줄인다: ① 소유자 리스 ts가 120초 이내면(기기가 동기화 중) 그 소유자 --apply 스킵
// ② blob 해시가 매니페스트 h와 다르면 skip(클라이언트가 blob을 먼저 쓴 순간) ③ 업로드 직전 재다운로드로 바이트 동일할 때만 upload
// ④ 업로드 뒤 매니페스트 h가 바뀐 rel은 RECHECK 로그. 재개: 회사 단위 진행을 .reseal-all-progress.json(cwd, 소유자는 해시)에 남긴다.
// 출력에 값·내용·소유자 id·경로(노트 제목)는 싣지 않는다(rel은 해시 8자). 드라이런은 DB에 아무것도 쓰지 않는다(계정 키 확보는 --apply에서만).
// 사용: node scripts/cloud-reseal-all.mjs [--apply] [--owner <uuid>] [--limit <회사 수>] [--concurrency 4] [--max-mb 64] [--retry-skipped]
//   (env: NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY — .env.local 자동 로드) 기본 드라이런 = 집계만.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'package.json'));
const { createClient } = req('@supabase/supabase-js');
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); }
const { NEXT_PUBLIC_SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
if (!URL_ || !KEY) { console.error('NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY가 필요합니다(.env.local 또는 env)'); process.exit(2); }
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
const { ensureAccountKey, loadAccountKeyReadOnly, clearAccountKey } = await import(join(ROOT, 'src', 'accountkey.mjs'));
const { sealSecret, openSecret, openSecretCompat, isEnvelopeGeneration, isCredWithdrawn } = await import(join(ROOT, 'src', 'secretbox.mjs'));
const { encSeg } = await import(join(ROOT, 'src', 'sync.mjs')); // 스토리지 키 인코더 — 비ASCII 조각은 u8-<base64url>(동기화와 단일 원천)
const keyOf = (owner, ws, rel) => [owner, ws, ...String(rel).split('/')].map(encSeg).join('/');
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16); // sync.mjs hashBuf와 동일(미수출)
const sha8 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8);

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const apply = process.argv.includes('--apply');
const onlyOwner = arg('--owner', null);
const limit = Number(arg('--limit', 0)) || Infinity;
const concurrency = Math.max(1, Number(arg('--concurrency', 4)) || 4);
const maxBytes = (Number(arg('--max-mb', 64)) || 64) * 1024 * 1024;
const retrySkipped = process.argv.includes('--retry-skipped'); // partial(해시 불일치·경합·부재)로 남은 회사를 다시 본다
const LEASE_FRESH_MS = 120_000;
const B = 'companies';
const PROGRESS = join(process.cwd(), '.reseal-all-progress.json');
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : { done: {} };
const saveProgress = () => writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
const fresh = (k) => sb.storage.from(B).download(`${k}?t=${Date.now()}`); // `?t=` 캐시 버스터 — 없으면 CDN이 옛 평문을 돌려준다
const tag = (owner, ws, rel) => `<${sha8(owner)}>/${ws}${rel ? `/${sha8(rel)}` : ''}`; // 로그용 — 소유자·경로(노트 제목) 미노출

async function listAll(prefix) {
  const out = []; let offset = 0;
  for (;;) { // 종료는 **빈 배치**로만 판정 — 서버가 페이지를 캡하면 `< 1000`은 조용히 잘린다(#437 검수 MEDIUM, cloudexport listDir과 동일)
    const { data, error } = await sb.storage.from(B).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${prefix ? sha8(prefix) : '/'} 실패: ${error.message}`);
    if (!data || data.length === 0) return out;
    out.push(...data); offset += data.length;
  }
}
async function mapLimit(items, n, fn) { const it = items[Symbol.iterator](); await Promise.all(Array.from({ length: n }, async () => { for (let c = it.next(); !c.done; c = it.next()) await fn(c.value); })); }
async function leaseFresh(owner) {
  const { data } = await fresh([owner, '_device-lease.json'].map(encSeg).join('/')); // 소유자 직속 — 빈 rel을 keyOf에 넘기면 encSeg('')='u8-'가 붙어 404(#437 2차 검수 HIGH)
  if (!data) return false;
  try { const j = JSON.parse(Buffer.from(await data.arrayBuffer()).toString()); return Date.now() - (Number(j?.ts) || 0) < LEASE_FRESH_MS; } catch { return false; }
}

const total = { companies: 0, sealed: 0, plain: 0, resealed: 0, skippedBig: 0, skippedHash: 0, skippedRace: 0, withdrawn: 0, missing: 0, failed: 0, e2ee: 0, noManifest: 0, manifestSealed: 0, recheck: 0, busyOwners: 0, nokey: 0, bytes: 0 };
const t0 = Date.now();
async function company(owner, ws) {
  const ck = `${sha8(owner)}/${ws}`;
  const prev = progress.done[ck];
  if (prev && !(retrySkipped && prev.partial)) return;
  const mkey = keyOf(owner, ws, '__manifest__.json');
  const { data: mdata, error: merr } = await fresh(mkey);
  if (merr || !mdata) { total.noManifest += 1; console.log('NO-MANIFEST', tag(owner, ws)); return; }
  const mbuf = Buffer.from(await mdata.arrayBuffer());
  let files;
  try { files = JSON.parse(openSecretCompat(mbuf).toString()).files ?? {}; }
  catch (e) {
    if (/열쇠가 없습니다|E2EE/.test(String(e.message))) { total.e2ee += 1; progress.done[ck] = { e2ee: true, at: new Date().toISOString() }; if (apply) saveProgress(); console.log('E2EE ', tag(owner, ws), '(v3 — 서버가 못 연다, 대상 아님)'); return; }
    total.failed += 1; console.log('MANIFEST-OPEN-FAIL', tag(owner, ws)); return;
  }
  const c = { sealed: 0, plain: 0, resealed: 0, skippedBig: 0, skippedHash: 0, skippedRace: 0, withdrawn: 0, missing: 0, failed: 0, recheck: 0 };
  const recheck = [];
  await mapLimit(Object.keys(files), concurrency, async (rel) => {
    if (typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) return; // 변조 키 위생(sync와 동일)
    const m = files[rel] ?? {};
    if (Number(m.s) > maxBytes) { c.skippedBig += 1; console.log('SKIP-BIG', tag(owner, ws, rel), `${Math.round(Number(m.s) / 1048576)}MB`); return; } // 다운로드 전에 거른다(메모리 상한)
    const key = keyOf(owner, ws, rel);
    const { data, error } = await fresh(key);
    if (error || !data) { c.missing += 1; return; }
    const buf = Buffer.from(await data.arrayBuffer());
    if (isCredWithdrawn(buf)) { c.withdrawn += 1; return; }
    if (isEnvelopeGeneration(buf)) { c.sealed += 1; return; }
    if (buf.length > maxBytes) { c.skippedBig += 1; return; }
    if (m.h && hashBuf(buf) !== m.h) { c.skippedHash += 1; return; } // 매니페스트와 다른 blob = 클라이언트가 방금 쓰는 중(② 유실 창 회피)
    c.plain += 1; total.bytes += buf.length;
    if (!apply) return;
    try {
      const sealed = sealSecret(buf); if (!openSecret(sealed).equals(buf)) throw new Error('self-check');
      const { data: again } = await fresh(key); const cur = again ? Buffer.from(await again.arrayBuffer()) : null; // ③ 직전 재확인
      if (!cur || !cur.equals(buf)) { c.skippedRace += 1; return; }
      const { error: uerr } = await sb.storage.from(B).upload(key, sealed, { upsert: true, contentType: 'application/octet-stream' });
      if (uerr) throw new Error(uerr.message);
      const { data: back } = await fresh(key); const bb = Buffer.from(await back.arrayBuffer());
      if (!(isEnvelopeGeneration(bb) && openSecret(bb).equals(buf))) throw new Error('verify');
      c.resealed += 1; recheck.push(rel);
    } catch (e) { c.failed += 1; console.log('FAIL', tag(owner, ws, rel), String(e.message).slice(0, 60)); }
  });
  if (apply && c.failed === 0) {
    // ④ 업로드 뒤 매니페스트 h가 바뀐 rel(그 사이 클라이언트가 새 판본을 올림)은 운영자 재확인 대상
    const { data: m2 } = await fresh(mkey); const mbuf2 = m2 ? Buffer.from(await m2.arrayBuffer()) : null;
    let files2 = files; try { if (mbuf2) files2 = JSON.parse(openSecretCompat(mbuf2).toString()).files ?? {}; } catch { /* 그대로 */ }
    for (const rel of recheck) if (files2[rel]?.h && files2[rel].h !== files[rel]?.h) { c.recheck += 1; console.log('RECHECK', tag(owner, ws, rel)); }
    // 매니페스트 봉인 — 파일 전부 성공했고, 읽은 뒤 바뀌지 않았을 때만(바뀌었으면 클라이언트가 살아 있어 곧 v2로 쓴다)
    if (mbuf2 && mbuf2.equals(mbuf) && !isEnvelopeGeneration(mbuf)) {
      try {
        const sealedM = sealSecret(mbuf);
        const { error: uerr } = await sb.storage.from(B).upload(mkey, sealedM, { upsert: true, contentType: 'application/octet-stream' });
        if (uerr) throw new Error(uerr.message);
        const { data: back } = await fresh(mkey); const bb = Buffer.from(await back.arrayBuffer());
        if (!(isEnvelopeGeneration(bb) && openSecret(bb).equals(mbuf))) throw new Error('verify');
        total.manifestSealed += 1;
      } catch (e) { c.failed += 1; console.log('MANIFEST-FAIL', tag(owner, ws), String(e.message).slice(0, 60)); }
    }
  }
  for (const k of Object.keys(c)) total[k] += c[k];
  total.companies += 1;
  console.log(apply ? 'DONE ' : 'DRY  ', tag(owner, ws), JSON.stringify(c));
  // 완료 기록은 실패 0 + 크기 초과 0일 때만(--max-mb를 키워 재실행하면 그 회사를 다시 본다)
  // 완료 기록은 실패 0 + 크기 초과 0일 때만. 해시 불일치·경합·부재로 건너뛴 파일이 있으면 partial로 남겨 --retry-skipped가 다시 본다(#437 2차 검수 LOW)
  if (apply && c.failed === 0 && c.skippedBig === 0) { progress.done[ck] = { ...c, partial: (c.skippedHash + c.skippedRace + c.missing) || undefined, at: new Date().toISOString() }; saveProgress(); }
}

const owners = (await listAll('')).map((o) => o.name).filter((n) => n && !n.startsWith('.') && (!onlyOwner || n === onlyOwner));
let n = 0;
outer: for (const owner of owners) {
  clearAccountKey();
  if (apply) {
    if (await leaseFresh(owner)) { total.busyOwners += 1; console.log('BUSY  ', tag(owner, ''), '(기기 동기화 중 — 이번 실행 스킵)'); continue; } // ① 유실 창 회피
    if (!(await ensureAccountKey(sb, owner))) { total.nokey += 1; console.log('NOKEY ', tag(owner, '')); continue; }
  } else if (!(await loadAccountKeyReadOnly(sb, owner))) { console.log('NOKEY ', tag(owner, ''), '(드라이런: v2 매니페스트 회사는 못 읽는다 — 키 미생성)'); } // 드라이런은 select만(DB 쓰기 0)
  for (const e of await listAll(owner)) {
    if (e.id) continue; // 파일(소유자 직속 제어 객체) 제외 — 폴더(회사)만
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    await company(owner, e.name);
    if (++n >= limit) break outer;
  }
}
console.log(JSON.stringify({ apply, owners: owners.length, ...total, plainMB: Math.round(total.bytes / 1048576), seconds: Math.round((Date.now() - t0) / 1000) }));
process.exit(total.failed ? 2 : 0);
