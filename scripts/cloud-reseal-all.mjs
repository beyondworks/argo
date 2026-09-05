// 기존 클라우드 회사 데이터 서버 일괄 재봉인 — 평문으로 올라가 있던 객체를 소유자 계정 키(v2 봉투)로 덮어쓴다.
// 대상 = 각 회사 __manifest__.json에 실린 rel만: 리스(_device-lease.json)·클레임·툼스톤 같은 제어 객체는 동기화가 봉투 개봉 없이 직접 파싱하므로
// 매니페스트 밖이라 자동 제외된다. 매니페스트 자신도 건드리지 않는다(클라이언트가 다음 사이클에 v2로 되쓴다).
// 클라이언트 영향 0: pull은 전 파일 관용 개봉(openSecretCompat), 매니페스트 h는 평문 해시라 변경 감지 무영향(≤v0.1.23은 업데이트 필요 — 발행 노트).
// 재개 가능: 회사 단위 진행을 .reseal-all-progress.json(cwd)에 남긴다. 값·내용은 절대 출력하지 않는다(소유자 id는 마스킹).
// 사용: node scripts/cloud-reseal-all.mjs [--apply] [--owner <uuid>] [--limit <회사 수>] [--concurrency 4] [--max-mb 64]
//   (env: NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY — .env.local 자동 로드) 기본 드라이런 = 집계만.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const { ensureAccountKey, clearAccountKey } = await import(join(ROOT, 'src', 'accountkey.mjs'));
const { sealSecret, openSecret, openSecretCompat, isEnvelopeGeneration, isCredWithdrawn } = await import(join(ROOT, 'src', 'secretbox.mjs'));
const { encSeg } = await import(join(ROOT, 'src', 'sync.mjs')); // 스토리지 키 인코더 — 한글 등 비ASCII 조각은 u8-<base64url>(동기화와 단일 원천)
const keyOf = (owner, ws, rel) => [owner, ws, ...String(rel).split('/')].map(encSeg).join('/');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const apply = process.argv.includes('--apply');
const onlyOwner = arg('--owner', null);
const limit = Number(arg('--limit', 0)) || Infinity;
const concurrency = Math.max(1, Number(arg('--concurrency', 4)) || 4);
const maxBytes = (Number(arg('--max-mb', 64)) || 64) * 1024 * 1024;
const B = 'companies';
const mask = (k) => k.replace(/^[^/]+\//, '<owner>/');
const PROGRESS = join(process.cwd(), '.reseal-all-progress.json');
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, 'utf8')) : { done: {} };
const saveProgress = () => writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
const fresh = (k) => sb.storage.from(B).download(`${k}?t=${Date.now()}`); // `?t=` 캐시 버스터 — 없으면 CDN이 옛 평문을 돌려준다

async function listAll(prefix) {
  const out = []; let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(B).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`list ${prefix || '/'} 실패: ${error.message}`);
    out.push(...(data ?? [])); if (!data || data.length < 1000) return out; offset += 1000;
  }
}
async function mapLimit(items, n, fn) { const it = items[Symbol.iterator](); await Promise.all(Array.from({ length: n }, async () => { for (let c = it.next(); !c.done; c = it.next()) await fn(c.value); })); }

const total = { companies: 0, sealed: 0, plain: 0, resealed: 0, skippedBig: 0, withdrawn: 0, missing: 0, failed: 0, nokey: 0, bytes: 0 };
const t0 = Date.now();
async function company(owner, ws) {
  const ck = `${owner}/${ws}`;
  if (progress.done[ck]) { return; }
  const { data: mdata, error: merr } = await fresh(keyOf(owner, ws, '__manifest__.json'));
  if (merr || !mdata) { return; } // 매니페스트 없음 = 동기화 회사 아님(제어 폴더 등)
  let files;
  try { files = JSON.parse(openSecretCompat(Buffer.from(await mdata.arrayBuffer())).toString()).files ?? {}; }
  catch { console.log('MANIFEST-OPEN-FAIL', mask(ck)); total.failed += 1; return; }
  const c = { sealed: 0, plain: 0, resealed: 0, skippedBig: 0, withdrawn: 0, missing: 0, failed: 0 };
  await mapLimit(Object.keys(files), concurrency, async (rel) => {
    if (typeof rel !== 'string' || rel.includes('..') || rel.startsWith('/')) return; // 변조 키 위생(sync와 동일)
    const key = keyOf(owner, ws, rel);
    const { data, error } = await fresh(key);
    if (error || !data) { c.missing += 1; return; }
    const buf = Buffer.from(await data.arrayBuffer());
    if (isCredWithdrawn(buf)) { c.withdrawn += 1; return; }
    if (isEnvelopeGeneration(buf)) { c.sealed += 1; return; }
    if (buf.length > maxBytes) { c.skippedBig += 1; console.log('SKIP-BIG', mask(key), `${Math.round(buf.length / 1048576)}MB`); return; }
    c.plain += 1; total.bytes += buf.length;
    if (!apply) return;
    try {
      const sealed = sealSecret(buf); if (!openSecret(sealed).equals(buf)) throw new Error('self-check');
      const { error: uerr } = await sb.storage.from(B).upload(key, sealed, { upsert: true, contentType: 'application/octet-stream' });
      if (uerr) throw new Error(uerr.message);
      const { data: back } = await fresh(key); const bb = Buffer.from(await back.arrayBuffer());
      if (!(isEnvelopeGeneration(bb) && openSecret(bb).equals(buf))) throw new Error('verify');
      c.resealed += 1;
    } catch (e) { c.failed += 1; console.log('FAIL', mask(key), String(e.message).slice(0, 60)); }
  });
  for (const k of Object.keys(c)) total[k] += c[k];
  total.companies += 1;
  console.log(apply ? 'DONE ' : 'DRY  ', mask(ck), JSON.stringify(c));
  if (apply && c.failed === 0) { progress.done[ck] = { ...c, at: new Date().toISOString() }; saveProgress(); }
}

const owners = (await listAll('')).map((o) => o.name).filter((n) => n && !n.startsWith('.') && (!onlyOwner || n === onlyOwner));
let n = 0;
outer: for (const owner of owners) {
  clearAccountKey();
  const ak = await ensureAccountKey(sb, owner);
  if (!ak) { total.nokey += 1; console.log('NOKEY <owner>'); continue; }
  for (const e of await listAll(owner)) {
    if (e.id) continue; // 파일(소유자 직속 제어 객체) 제외 — 폴더(회사)만
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    await company(owner, e.name);
    if (++n >= limit) break outer;
  }
}
console.log(JSON.stringify({ apply, owners: owners.length, ...total, plainMB: Math.round(total.bytes / 1048576), seconds: Math.round((Date.now() - t0) / 1000) }));
process.exit(total.failed ? 2 : 0);
