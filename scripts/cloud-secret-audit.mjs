#!/usr/bin/env node
// 클라우드(Supabase Storage 'companies') 비밀값 평문 감사 + 재봉인 — 유건 지시(2026-09-05) "환경변수는 Supabase에 평문으로 남으면 안 돼".
// 검사: ① 제어 파일 3종(.secrets.json·connections.json·mcp.json) ② 자격 파일명 규칙(secretbox.isSecretNameRel — .env·credentials.json·token(s).json·*.pem·secret.yaml…)에
// 걸리는 객체를 전 소유자·전 회사 트리에서 찾아 봉투(argosecret.*) 여부를 본다. --reseal이면 평문을 소유자 계정 키(v2 봉투)로 덮어쓴다 —
// pull은 모든 파일에 openSecretCompat을 적용하므로 구·신 클라이언트 모두 안전하게 연다(삭제·마커는 로컬 오삭제/손상 위험이 있어 쓰지 않는다).
// 값·내용은 절대 출력하지 않는다(객체 경로는 소유자 id를 가린다). 실측 2026-09-05: 484 소유자, 제어 파일 봉투 724·회수 마커 44·평문 1, 자격 파일명 평문 23 → 전부 재봉인.
// 사용: node scripts/cloud-secret-audit.mjs [--reseal] [--verify]   (env: NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY — .env.local 자동 로드)
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'package.json'));
const { createClient } = req('@supabase/supabase-js');
const envFile = join(ROOT, '.env.local');
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
const { NEXT_PUBLIC_SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: KEY } = process.env;
if (!URL_ || !KEY) { console.error('NEXT_PUBLIC_SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY가 필요합니다(.env.local 또는 env)'); process.exit(2); }
const sb = createClient(URL_, KEY, { auth: { persistSession: false } });
const { isSecretRel } = await import(join(ROOT, 'src', 'secretbox.mjs'));
const { ensureAccountKey, clearAccountKey } = await import(join(ROOT, 'src', 'accountkey.mjs'));
const { sealSecret, openSecret, isEnvelopeGeneration } = await import(join(ROOT, 'src', 'secretbox.mjs'));
const reseal = process.argv.includes('--reseal'); const verify = process.argv.includes('--verify');
const B = 'companies'; const mask = (k) => k.replace(/^[^/]+\//, '<owner>/');
const DEPS = /(\/node_modules\/|\/\.git\/)/; // 의존성 트리는 CA 번들뿐이라 걷지 않는다(속도) — 필요하면 제거
const fresh = (k) => sb.storage.from(B).download(`${k}?t=${Date.now()}`);

const candidates = []; let dirs = 0;
async function walk(prefix, relBase) {
  let offset = 0;
  for (;;) {
    const { data, error } = await sb.storage.from(B).list(prefix, { limit: 1000, offset });
    if (error) { console.log('list fail', mask(prefix), error.message); return; }
    const sub = [];
    for (const e of data ?? []) {
      const p = `${prefix}/${e.name}`; const rel = relBase ? `${relBase}/${e.name}` : e.name;
      if (e.id === null || e.metadata === null) { if (!DEPS.test(`${p}/`)) sub.push([p, rel]); }
      else if (isSecretRel(rel)) candidates.push({ key: p, rel, owner: prefix.split('/')[0], size: e.metadata?.size ?? 0 });
    }
    dirs += 1;
    for (let i = 0; i < sub.length; i += 8) await Promise.all(sub.slice(i, i + 8).map(([p, rel]) => walk(p, rel)));
    if (!data || data.length < 1000) break; offset += 1000;
  }
}
const t0 = Date.now();
const { data: owners } = await sb.storage.from(B).list('', { limit: 1000 });
for (let i = 0; i < (owners ?? []).length; i += 4) {
  await Promise.all(owners.slice(i, i + 4).map(async (o) => {
    const { data: cos } = await sb.storage.from(B).list(o.name, { limit: 1000 });
    for (const c of cos ?? []) if (c.id === null || c.metadata === null) await walk(`${o.name}/${c.name}`, '');
  }));
  if (i % 40 === 0) console.log(`  소유자 ${i}/${owners.length}, 디렉터리 ${dirs}, 후보 ${candidates.length}, ${Math.round((Date.now() - t0) / 1000)}s`);
}
console.log(`후보(자격 계급 객체) ${candidates.length}개 — 봉투 여부 확인`);
const tally = { sealed: 0, withdrawn: 0, plain: 0, resealed: 0, failed: 0, openFail: 0 };
for (const c of candidates) {
  const { data, error } = await fresh(c.key); if (error) { tally.failed += 1; continue; }
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.toString('latin1') === 'argosecret.v2:credSync-off') { tally.withdrawn += 1; continue; }
  if (isEnvelopeGeneration(buf)) {
    tally.sealed += 1;
    if (verify) { clearAccountKey(); await ensureAccountKey(sb, c.owner); try { openSecret(buf); } catch { tally.openFail += 1; console.log('OPEN-FAIL', mask(c.key)); } }
    continue;
  }
  tally.plain += 1; console.log('PLAIN', mask(c.key), `${buf.length}B`);
  if (!reseal) continue;
  clearAccountKey(); const ak = await ensureAccountKey(sb, c.owner); if (!ak) { tally.failed += 1; console.log('  NOKEY'); continue; }
  const sealed = sealSecret(buf); if (!openSecret(sealed).equals(buf)) { tally.failed += 1; continue; }
  const { error: upErr } = await sb.storage.from(B).upload(c.key, sealed, { upsert: true, contentType: 'application/octet-stream' });
  if (upErr) { tally.failed += 1; console.log('  UPLOAD-FAIL', upErr.message); continue; }
  const { data: back } = await fresh(c.key); const bb = Buffer.from(await back.arrayBuffer());
  if (isEnvelopeGeneration(bb) && openSecret(bb).equals(buf)) { tally.resealed += 1; console.log('  RESEALED'); } else { tally.failed += 1; console.log('  VERIFY-FAIL'); }
}
console.log(JSON.stringify({ reseal, verify, owners: owners?.length ?? 0, candidates: candidates.length, ...tally, seconds: Math.round((Date.now() - t0) / 1000) }));
process.exit(tally.plain > 0 && !reseal ? 1 : tally.failed ? 2 : 0);
