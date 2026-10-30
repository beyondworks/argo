// 0.1.124 — 동기화가 꺼진 이유를 가른다(2026-10-30 고객 C 재판정: 두 PC 모두 앱만 썼는데 메인 PC 꼬리표가 sync/off — 앱 사이드카가 부모 env의
// ARGO_SYNC=0을 물려받은 것으로 추정, src-tauri lib.rs는 부모 env를 지우지 않는다). 꺼졌으면 꼬리표·설정 카드가 이유를 싣는다:
// env = 환경변수 ARGO_SYNC=0(로그인해도 켜지지 않는다), nosess = 기기 세션·서비스 자격 없음(로그아웃).
// 그리고 /auth/confirm은 이 기기에 이미 같은 계정의 기기 세션이 있었을 때만 게스트 회사를 귀속한다(다른 로그인 경로와 같은 claimOrDefer).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';
import { syncHeldView, syncDiagTag, syncOffReason } from '../src/sync.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
function runChild(root, body, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timeout\n${err.slice(-1500)}`)); }, 60_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-1500)}\n${err.slice(-1500)}`));
      resolve({ r: JSON.parse(line.slice(2)), out: out + err });
    });
  });
}

test('꺼진 이유 판정 — 환경변수가 먼저, 그다음 세션 없음. 켜져 있으면 종전 그대로(경우 표 A1~A4·A6)', () => {
  assert.equal(syncOffReason({ ARGO_SYNC: '0' }), 'env', 'A1·A2 ARGO_SYNC=0이면 세션 유무와 관계없이 env');
  assert.equal(syncOffReason({}), 'nosess', 'A3');
  const off = syncHeldView({}, { on: false, loopStarted: false, offReason: 'env' });
  assert.equal(off.phase, 'off'); assert.equal(off.errorCode, 'env');
  assert.equal(syncDiagTag(off), 'sync/off.env.-.o0f0.c0', '꼬리표 sync/off.env');
  assert.equal(syncDiagTag(syncHeldView({}, { on: false, loopStarted: false, offReason: 'nosess' })), 'sync/off.nosess.-.o0f0.c0');
  assert.equal(syncHeldView({ phase: 'idle', errorCode: 'company' }, { on: true, loopStarted: true, offReason: 'env' }).errorCode, 'company', 'A4 켜져 있으면 offReason을 보지 않는다');
});

test('ARGO_SYNC=0 + 기기 세션 — 기동 로그 한 줄(두 번 불러도 한 번)과 30분 확인 요청 꼬리표 sync/off.env(경우 표 A1)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const xci = [];
  fake.fault = (req, path) => { if (path.endsWith('/rpc/argo_min_app_version')) xci.push(String(req.headers['x-client-info'] ?? '')); return null; };
  const root = await mkdtemp(join(tmpdir(), 'argo-0124-offenv-'));
  seedRoot(root, { url: fake.url, wsId: 'co-off' });
  const body = `
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
sync.ensureSync(); sync.ensureSync();
const { getFreshDeviceSession } = await import(${JSON.stringify(srcUrl('devicesession.mjs'))});
await getFreshDeviceSession();
await new Promise((r) => setTimeout(r, 800));
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ on: s.on, held: s.held }) + '\\n');
process.exit(0);`;
  const { r, out } = await runChild(root, body, { ARGO_SYNC: '0', NODE_TEST_CONTEXT: '' });
  assert.equal(r.on, false);
  assert.equal(r.held.phase, 'off'); assert.equal(r.held.errorCode, 'env', '설정 카드가 읽는 값(sync.held.errorCode)');
  assert.equal(out.split('\n').filter((l) => l.startsWith('[argo] sync phase=off err=env')).length, 1, '진단 로그 한 줄(프로세스당 한 번)');
  assert.ok(xci.length >= 1, '확인 요청이 나갔다');
  assert.match(xci.at(-1), / sync\/off\.env\./, xci.at(-1));
  assert.equal(fake.hits.filter((h) => h.k.includes('/storage/')).length, 0, '꺼져 있으니 저장소 요청 0(종전 그대로)');
});

test('설정 동기화 카드 — 꺼진 이유가 env면 환경변수 문구를 꺼짐 갈래에 한 줄 싣는다(ko·en 사전 등록)', () => {
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const offBranch = page.slice(page.indexOf("t('settings.sync.offHelp')") - 600, page.indexOf("t('settings.sync.offHelp')"));
  assert.match(offBranch, /sync\?\.held\?\.errorCode === 'env' \? <p [^>]*>\{t\('settings\.sync\.offEnv'\)\}<\/p> : null/);
  const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  assert.match(dict, /'settings\.sync\.offEnv': \['환경변수\(ARGO_SYNC=0\)로 이 기기의 동기화가 꺼져 있습니다\.', 'Sync is turned off on this device by an environment variable \(ARGO_SYNC=0\)\.'\]/);
});

/* ─── /auth/confirm 귀속(경우 표 B2~B4) ─── */
async function confirmAs({ prior, loginAs }) {
  const fake = await startFakeSupabase({ plan: 'pro', userId: loginAs }); fakes.push(fake);
  fake.fault = (req, path) => (path === '/auth/v1/verify' ? { status: 200, body: {
    access_token: 'h.p.s', refresh_token: 'rt-9', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: loginAs, email: `${loginAs}@example.test`, aud: 'authenticated', role: 'authenticated' },
  } } : null);
  const root = await mkdtemp(join(tmpdir(), 'argo-0124-confirm-'));
  mkdirSync(join(root, 'guest-co'), { recursive: true });
  writeFileSync(join(root, 'guest-co', 'company.json'), JSON.stringify({ id: 'guest-co', name: '게스트 회사', owner: 'captain' }));
  writeFileSync(join(root, '.guest-mode.json'), JSON.stringify({ enabled: true }));
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  if (prior) writeFileSync(join(root, '.device-session.json'), JSON.stringify({ url: fake.url, anonKey: 'anon-fixture', access_token: 'old.p.s', refresh_token: 'rt-old', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: prior, email: '' } }), { mode: 0o600 });
  const body = `
const { register } = await import('node:module');
register(${JSON.stringify(new URL('./helpers/next-esm-resolve.mjs', import.meta.url).href)});
const route = await import(${JSON.stringify(new URL('../app/auth/confirm/route.js', import.meta.url).href)});
const { NextRequest } = await import('next/server');
const res = await route.GET(new NextRequest('http://127.0.0.1:3299/auth/confirm?token_hash=th-x&type=email', { headers: { host: '127.0.0.1:3299', 'sec-fetch-site': 'cross-site' } }));
process.stdout.write('\\n@@' + JSON.stringify({ status: res.status }) + '\\n');
process.exit(0);`;
  const { r } = await runChild(root, body, { NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture', ARGO_SYNC: '0' });
  assert.ok(fake.count('POST /auth/v1/verify') >= 1, '확인 경로를 실제로 탔다');
  assert.ok(r.status >= 300 && r.status < 400);
  return {
    owner: JSON.parse(readFileSync(join(root, 'guest-co', 'company.json'), 'utf8')).ownerId ?? null,
    guestLeft: existsSync(join(root, '.guest-mode.json')),
    pending: existsSync(join(root, '.claim-pending.json')),
  };
}

test('/auth/confirm — 이 기기에 이미 같은 계정의 기기 세션이 있었으면 게스트 회사를 그 계정으로 귀속한다(B3)', async () => {
  const r = await confirmAs({ prior: 'u-me', loginAs: 'u-me' });
  assert.equal(r.owner, 'u-me'); assert.equal(r.guestLeft, false); assert.equal(r.pending, false);
});

test('/auth/confirm — 이전 세션이 없거나(게스트 기기, 교차 사이트 공격자 링크) 다른 계정이면 귀속·대기 표지 없음(B2·B4, PR #1183 검수 유지)', async () => {
  for (const prior of [null, 'u-me']) {
    const r = await confirmAs({ prior, loginAs: 'u-attacker' });
    assert.equal(r.owner, null, `이전 세션 ${prior ?? '없음'} — 공격자 계정으로 넘어가지 않는다`);
    assert.equal(r.guestLeft, true); assert.equal(r.pending, false, '대기 표지도 남기지 않는다(동기화가 나중에 귀속하지 않게)');
  }
});

test('argo login(앱 공유 CLI)도 다른 로그인 경로와 같은 claimOrDefer — 실패하면 대기 표지(같은 uid 10분 재시도)(경우 표 B1)', () => {
  const src = readFileSync(new URL('../bin/argo.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(guestModeOn\(\)\) \{ const \{ claimOrDefer \} = await import\('\.\.\/src\/accountclaim\.mjs'\); const r = await claimOrDefer\(user\.id\);/);
  assert.equal(/claimLocalToAccount\(/.test(src), false, 'CLI가 실패를 남기지 않는 직접 귀속으로 돌아왔다');
});
