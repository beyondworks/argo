// 매니페스트 원본 확인 보류(결함 B, #1073)의 화면 상태 배선 — 엄격 검수(M2 총괄 독립 에이전트, 2026-10-17 22:09 KST) 지적 1·2.
// 실제 동기화 루프(ensureSync)를 자식 프로세스로 돌리고 가짜 Supabase HTTP(실제 supabase-js)를 쓴다 — home-first-sync와 같은 틀.
//  S1c. 보류가 이어지면 3번째에 회사 오류(화면)에 원인 코드 manifest-stale이 남고, 그 뒤는 실패 대기라 매니페스트 GET·info가 늘지 않는다.
//       (지적 전: lastError가 비워져 "마지막 동기화 <시각> · ↑0 ↓0"만 보였고, 8초 주기면 기기·회사당 분당 GET 15건)
//  S4.  새 기기 첫 복원의 매니페스트 읽기가 보류되면(회사 폴더가 아직 없다 — localDirCreated false) 다음 사이클에도 복원 대상으로 남고
//       restoring 표시도 유지된다. 지적 전: 다음 발견(DISCOVER_MS 300초)까지 빠져 홈이 최대 5분 빈 목록이었다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import { syncErrorView } from '../app/c/[ws]/settings/sync-error.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-stale-cycle-parent-')); // 봉인(secretbox → workspace.mjs) 임포트보다 먼저
const OWNER = 'u1';
const key = (ws, rel) => `companies/${OWNER}/${ws}/${rel}`;
const meta = (buf) => ({ m: 1000, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });
const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });

async function putRemoteCompany(fake, ws, n = 3) {
  const { sealSecret } = await import('../src/secretbox.mjs');
  const files = {};
  const co = Buffer.from(JSON.stringify({ id: ws, name: '원격 회사', ownerId: OWNER }));
  fake.store.set(key(ws, 'company.json'), co); files['company.json'] = meta(co);
  for (let i = 0; i < n; i++) { const b = Buffer.from(`# 노트 ${i}\n`); fake.store.set(key(ws, `vault/n${i}.md`), b); files[`vault/n${i}.md`] = meta(b); }
  fake.store.set(key(ws, '__manifest__.json'), sealSecret(Buffer.from(JSON.stringify({ files }))));
  return sealSecret(Buffer.from(JSON.stringify({ files: { 'company.json': files['company.json'] } }))); // 옛 판(항목이 적은 다른 바이트)
}
const isManifestGet = (req, path, ws) => req.method === 'GET' && path.endsWith(`/${ws}/__manifest__.json`) && !path.includes('/object/info/');
const isManifestInfo = (req, path, ws) => req.method === 'GET' && path.endsWith(`/${ws}/__manifest__.json`) && path.includes('/object/info/');

/** 자식에서 동기화를 켜고 50ms마다 { 첫 동기화 중?, 회사 폴더가 있나, 회사 오류 } 를 기록한다. */
function runChild(root, ws, { ms, env = {} } = {}) {
  const script = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const { existsSync } = await import('node:fs');
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const samples = [];
const sample = () => { const s = sync.syncStatus(); samples.push({ p: sync.firstSyncPending(), has: existsSync(${JSON.stringify(join(root, ws, 'company.json'))}), done: s.lastTs !== null,
  lastError: s.lastError, error: s.companies[${JSON.stringify(ws)}]?.error ?? '', skipped: s.companies[${JSON.stringify(ws)}]?.skipped ?? null }); };
sample();
sync.ensureSync();
const t0 = Date.now();
while (Date.now() - t0 < ${Number(ms)}) { await new Promise((r) => setTimeout(r, 50)); sample(); }
process.stdout.write('\\n@@' + JSON.stringify(samples) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root, { ARGO_SYNC_CYCLE_MS: '200', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${err.slice(-1500)}`)); }, ms + 30_000);
    p.on('exit', () => { clearTimeout(t); const line = out.split('\n').find((l) => l.startsWith('@@')); line ? resolve(JSON.parse(line.slice(2))) : reject(new Error(`no samples\n${out.slice(-1500)}\n${err.slice(-1500)}`)); });
  });
}
async function newDeviceRoot(url) {
  const root = await mkdtemp(join(tmpdir(), 'argo-stale-cycle-'));
  writeFileSync(join(root, '.device-session.json'), JSON.stringify({
    url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: OWNER, email: '' },
  }), { mode: 0o600 });
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  return root;
}

test('S1c 원본 확인이 계속 실패 — 3번째 보류에 회사 오류 manifest-stale(화면), 그 뒤는 실패 대기라 매니페스트 GET·info 각 6건 이하', { timeout: 90_000 }, async () => {
  const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
  await useFakeAccountKey(1, OWNER);
  const WS = 'co-stale';
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: { companies: [WS] } }); fakes.push(fake);
  const old = await putRemoteCompany(fake, WS);
  const root = await mkdtemp(join(tmpdir(), 'argo-stale-cycle-'));
  seedRoot(root, { url: fake.url, userId: OWNER, wsId: WS }); // 이 기기에 이미 있는 회사(유휴 기기)
  fake.fault = (req, path) => (isManifestGet(req, path, WS) ? { raw: old } : null); // CDN 옛 판이 걷히지 않는다
  const t0 = Date.now();
  const s = await runChild(root, WS, { ms: 4000 }); // 200ms 주기 — 대기 없으면 약 20사이클
  const gets = fake.hits.filter((h) => h.t >= t0 && h.k.startsWith('GET ') && h.k.endsWith(`/${WS}/__manifest__.json`) && !h.k.includes('/object/info/')).length;
  const infos = fake.hits.filter((h) => h.t >= t0 && h.k.endsWith(`/${WS}/__manifest__.json`) && h.k.includes('/object/info/')).length;
  assert.ok(gets >= 6, `전제: 보류가 3번 났다(GET ${gets})`);
  assert.ok(gets <= 6 && infos <= 6, `요청 상한: 매니페스트 GET ${gets}·info ${infos}`);
  const last = s.at(-1);
  assert.match(last.error, /manifest-stale/, `회사 오류에 원인 코드: ${JSON.stringify(last)}`);
  assert.match(last.lastError, /manifest-stale/, '설정 카드가 읽는 lastError에도 남는다(비워지지 않는다)');
  assert.equal(syncErrorView(last.lastError)?.key, 'settings.sync.err.generic', '화면 문구는 일반 오류(자동 재시도) — 네트워크 오류로 잘못 안내하지 않는다');
  assert.equal(fake.count(`POST /storage/v1/object/companies/${OWNER}/${WS}/__manifest__.json`) + fake.count(`PUT /storage/v1/object/companies/${OWNER}/${WS}/__manifest__.json`), 0, '덮어쓰지 않는다');
});

test('S4 새 기기 첫 복원 읽기가 보류(회사 폴더 아직 없음 — localDirCreated false) — 다음 사이클에도 복원 대상, restoring 유지, 옛 판이 걷히면 바로 받는다(5분 발견 대기 없음)', { timeout: 90_000 }, async () => {
  const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
  await useFakeAccountKey(1, OWNER);
  const WS = 'co-restore-stale';
  const fake = await startFakeSupabase({ userId: OWNER, syncIndex: { companies: [WS] } }); fakes.push(fake);
  const old = await putRemoteCompany(fake, WS);
  let staleLeft = 4; // 첫 두 사이클(사이클마다 GET 2)은 옛 판 — 보류 2번(실패 대기 문턱 3번 아래)
  fake.fault = (req, path) => (isManifestGet(req, path, WS) && staleLeft > 0 ? (staleLeft--, { raw: old }) : null);
  const s = await runChild(await newDeviceRoot(fake.url), WS, { ms: 6000 }); // ARGO_SYNC_DISCOVER_MS 기본(300초) — 다시 발견되기를 기다리면 6초 안에 못 받는다
  assert.equal(staleLeft, 0, '전제: 첫 복원 읽기가 두 번 보류됐다');
  assert.ok(s.some((x) => x.skipped === 'manifest-stale' && !x.has), '전제: 보류된 사이클에 회사 폴더가 아직 없었다');
  assert.ok(s.every((x) => x.p || x.has), `회사가 아직 없는데 "내려받는 중"이 아닌 순간이 없다: ${JSON.stringify(s.filter((x) => !x.p && !x.has).slice(0, 3))}`);
  const last = s.at(-1);
  assert.deepEqual([last.has, last.p], [true, false], `옛 판이 걷히자 받았다: ${JSON.stringify(last)}`);
});
