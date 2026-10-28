// 기기 간 동기화가 조용히 서는 경로(2026-10-28 유료 사용자 C — 메인 PC 회사가 노트북에 안 내려옴, 메인 PC의 storage·argo_sync_index 요청 0).
// 잠그는 것:
//  ① 앱의 구글·깃허브 로그인(브라우저 핸드오프 → /api/device/link)도 게스트 시절 만든 주인 없는 회사를 그 계정으로 귀속하고 게스트 표지를 지운다
//     (수정 전: device/login·auth/callback만 귀속 — 앱 로그인 사용자는 .guest-mode.json enabled:true가 남고 회사가 no-owner로 영영 동기화 대상 밖).
//  ② 동기화 자격(기기 세션)이 프로세스가 뜬 뒤에 생겨도(로그인 라우트를 거치지 않은 경로) 루프가 붙는다 — 네트워크 요청 없이 파일만 본다.
//  ③ 건너뛴 이유(주인 없음·다른 계정 주인·무료·잠금 대기·루프 정지)를 syncStatus().held로 모은다 — 설정 '기기 간 동기화' 카드가 문장과 조치로 보인다.
//  ④ (핀) 무료로 확정된 동안은 업로드 0, 요금제 캐시가 지워지면(결제 화면 조회) Pro 판정으로 다시 올린다 — 루프는 멈추지 않는다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { childEnv, srcUrl, seedRoot } from './helpers/sync-child.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
const uploads = (fake) => fake.hits.filter((h) => (h.k.startsWith('POST /storage/v1/object/') || h.k.startsWith('PUT /storage/v1/object/')) && !h.k.includes('/object/list/')).length;
const storageHits = (fake) => fake.hits.filter((h) => h.k.includes('/storage/v1/')).length;

/** 자식에서 동기화 루프를 켜고, 각 단계 시각에 스크립트 조각을 돌린 뒤 마지막에 syncStatus()를 받는다. */
function runChild({ root, env = {}, script, waitMs }) {
  const body = `
globalThis.__argoRunnerProbe = { ts: Date.now(), ok: true };
const sync = await import(${JSON.stringify(srcUrl('sync.mjs'))});
const planCache = await import(${JSON.stringify(srcUrl('plan-cache.mjs'))});
const fs = await import('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
${script}
await sleep(${Number(waitMs)});
const s = sync.syncStatus();
process.stdout.write('\\n@@' + JSON.stringify({ on: s.on, lastError: s.lastError, plan: s.plan, held: s.held, companies: s.companies }) + '\\n');
process.exit(0);`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], { env: childEnv(root, { ARGO_AGENT_LINK: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child timeout\n${err.slice(-2000)}`)); }, waitMs + 30_000);
    p.on('exit', () => {
      clearTimeout(t);
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no status\n${out.slice(-2000)}\n${err.slice(-2000)}`));
      resolve({ status: JSON.parse(line.slice(2)), out, err });
    });
  });
}

const devSession = (url, userId = 'u1') => JSON.stringify({
  url, anonKey: 'anon-fixture', access_token: 'h.p.s', refresh_token: 'rt-0', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: userId, email: '' },
});

test('① 앱 로그인(/api/device/link)도 게스트 회사를 계정으로 귀속하고 게스트 표지를 지운다 — 그래야 다음 사이클에 올라간다', async () => {
  const fake = await startFakeSupabase({ plan: 'pro', userId: 'u-link' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-link-claim-'));
  mkdirSync(join(root, 'guest-co'), { recursive: true });
  writeFileSync(join(root, 'guest-co', 'company.json'), JSON.stringify({ id: 'guest-co', name: '게스트 회사', owner: 'captain', created: new Date().toISOString() }));
  writeFileSync(join(root, '.guest-mode.json'), JSON.stringify({ enabled: true, ts: '2026-10-14T00:00:00.000Z' }));
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  // 라우트는 next 모듈을 쓰므로 자식에서 부른다(AUTH_ON은 app/auth.mjs를 불러오는 순간 env로 정해진다)
  const body = `
const { register } = await import('node:module');
register(${JSON.stringify(new URL('./helpers/next-esm-resolve.mjs', import.meta.url).href)});
const route = await import(${JSON.stringify(new URL('../app/api/device/link/route.js', import.meta.url).href)});
const req = new Request('http://127.0.0.1:3299/api/device/link', { method: 'POST', headers: { host: '127.0.0.1:3299', 'content-type': 'application/json' },
  body: JSON.stringify({ access_token: 'h.p.s', refresh_token: 'rt-0' }) });
const fs = await import('node:fs');
const cross = await route.POST(new Request('http://127.0.0.1:3299/api/device/link', { method: 'POST', headers: { host: '127.0.0.1:3299', 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ access_token: 'h.p.s', refresh_token: 'rt-0' }) }));
const crossOwner = JSON.parse(fs.readFileSync(process.env.ARGO_ROOT + '/guest-co/company.json', 'utf8')).ownerId ?? null;
const crossSession = fs.existsSync(process.env.ARGO_ROOT + '/.device-session.json');
const res = await route.POST(req);
process.stdout.write('\\n@@' + JSON.stringify({ status: res.status, body: await res.json(), cross: cross.status, crossOwner, crossSession }) + '\\n');
process.exit(0);`;
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], {
      env: childEnv(root, { NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture', ARGO_SYNC: '0', ARGO_AGENT_LINK: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-1500)}\n${err.slice(-1500)}`));
      resolve(JSON.parse(line.slice(2)));
    });
  });
  assert.equal(r.cross, 403, '교차 사이트 요청은 거절(악성 페이지가 자기 계정 토큰으로 이 기기·게스트 회사를 가져가지 못하게)');
  assert.equal(r.crossOwner, null, '거절된 요청은 귀속하지 않는다');
  assert.equal(r.crossSession, false, '거절된 요청은 기기 세션을 저장하지 않는다');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const meta = JSON.parse(readFileSync(join(root, 'guest-co', 'company.json'), 'utf8'));
  assert.equal(meta.ownerId, 'u-link', '게스트 회사가 로그인 계정으로 귀속(수정 전: 주인 없음 그대로 — 동기화 대상 밖)');
  assert.equal(existsSync(join(root, '.guest-mode.json')), false, '게스트 표지 해제(수정 전: enabled:true가 남았다 — 고객 C 쪽지와 같은 모양)');
  assert.equal(r.body.claimed?.claimed, 1, '응답에 귀속 결과(device/login과 같은 모양)');
});

test('② 프로세스가 뜬 뒤 기기 세션이 생겨도 동기화 루프가 붙는다 — 로그인 라우트를 거치지 않은 경로(수정 전: 재시작 전까지 요청 0)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-late-creds-'));
  mkdirSync(join(root, 'co-late'), { recursive: true });
  writeFileSync(join(root, 'co-late', 'company.json'), JSON.stringify({ id: 'co-late', name: 'Late', ownerId: 'u1' }));
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  const { status } = await runChild({
    root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 5000,
    script: `sync.ensureSync(); await sleep(1200); fs.writeFileSync(${JSON.stringify(join(root, '.device-session.json'))}, ${JSON.stringify(devSession(fake.url))}, { mode: 0o600 });`,
  });
  assert.equal(status.on, true);
  assert.ok(uploads(fake) > 0, `로그인 뒤 회사가 올라간다(업로드 ${uploads(fake)}건)`);
  assert.ok(status.companies['co-late'] && !['no-owner', 'foreign-owner', 'free-plan'].includes(status.companies['co-late'].skipped), JSON.stringify(status.companies)); // 올린 뒤 유휴 확인(idle-probe)은 정상
});

test('③ 건너뛴 이유를 모은다 — 주인 없음·다른 계정 주인 회사 수(회사 id 없이)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-held-'));
  seedRoot(root, { url: fake.url, wsId: 'co-mine' });
  for (const [id, owner] of [['co-orphan', null], ['co-orphan2', null], ['co-theirs', 'u-other']]) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, 'company.json'), JSON.stringify({ id, name: id, ...(owner ? { ownerId: owner } : {}) }));
  }
  const { status } = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 3000, script: 'sync.ensureSync();' });
  assert.equal(status.held?.noOwner, 2, JSON.stringify(status.held));
  assert.equal(status.held?.foreignOwner, 1);
  assert.equal(status.held?.freePlan, 0);
  assert.equal(status.held?.stalled, 0);
  assert.equal(JSON.stringify(status.held).includes('co-orphan'), false, '회사 id·이름은 싣지 않는다(같은 기기의 다른 계정 화면)');
});

test('④ 무료 확정 동안 업로드 0 → 결제 화면 조회(캐시 지움) 뒤 Pro 판정으로 다시 올린다 — 루프는 멈추지 않는다', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  let plan = 'free';
  fake.fault = (req, path) => (path.endsWith('/rpc/my_plan') ? { status: 200, body: { plan } } : null);
  const root = await mkdtemp(join(tmpdir(), 'argo-free-pro-'));
  seedRoot(root, { url: fake.url, wsId: 'co-fp' });
  // 무료 상태(.sync-state 있음 = 복원 아님)로 시작 — 고객 C처럼 무료일 때 만든 회사
  writeFileSync(join(root, 'co-fp', '.sync-state.json'), JSON.stringify({ files: {}, ts: Date.parse('2026-10-08T00:00:00Z') }));
  const flipAt = Date.now() + 2500;
  setTimeout(() => { plan = 'pro'; }, 2500);
  const { status } = await runChild({
    root, env: { ARGO_SYNC_CYCLE_MS: '400' }, waitMs: 3500,
    script: `sync.ensureSync(); await sleep(2300); const before = sync.syncStatus(); process.stdout.write('\\n##' + JSON.stringify(before.held) + '\\n'); await sleep(400); planCache.invalidatePlanCache();`,
  });
  const beforeFlip = fake.hits.filter((h) => h.t < flipAt && h.k.startsWith('POST /storage/v1/object/') && !h.k.includes('/list/')).length;
  assert.equal(beforeFlip, 0, '무료 확정 동안 업로드 0');
  assert.ok(uploads(fake) > 0, `Pro 전환 뒤 업로드(${uploads(fake)}건)`);
  assert.equal(status.plan, 'pro');
  assert.equal(status.held?.freePlan, 0);
});

test('③ 순수 판정 — 루프 정지(사이클이 오래 안 돎)·잠금 대기·무료 회사 수', async () => {
  const { syncHeldView } = await import('../src/sync.mjs');
  const now = 10_000_000;
  const base = { companies: {}, scanAt: now - 1000, cycleEndAt: now - 1000, cycling: false };
  assert.deepEqual(syncHeldView(base, { now, on: true, loopStarted: true, lockElsewhere: false, cycleMs: 8000 }),
    { noOwner: 0, foreignOwner: 0, freePlan: 0, lockWait: false, stalled: 0, notStarted: false, phase: 'starting', lastCycleAt: now - 1000, errorCode: '', lockPid: null, lockVer: null });
  // 사이클 끝이 10분 전이고 지금 사이클 중이 아님 = 루프가 서 있다(분 단위로)
  assert.equal(syncHeldView({ ...base, cycleEndAt: now - 10 * 60_000 }, { now, on: true, loopStarted: true, cycleMs: 8000 }).stalled, 10);
  // 긴 사이클(큰 파일 올리기) 중에는 정지로 보지 않는다
  assert.equal(syncHeldView({ ...base, cycleEndAt: now - 10 * 60_000, cycling: true }, { now, on: true, loopStarted: true, cycleMs: 8000 }).stalled, 0);
  // 동기화가 꺼져 있으면 아무것도 싣지 않는다
  assert.equal(syncHeldView({ ...base, cycleEndAt: now - 10 * 60_000 }, { now, on: false, loopStarted: false, cycleMs: 8000 }).stalled, 0);
  assert.equal(syncHeldView(base, { now, on: true, loopStarted: false, cycleMs: 8000 }).notStarted, true);
  const lw = syncHeldView({ ...base, phase: 'lock-wait', errorCode: 'other-process' }, { now, on: true, loopStarted: true, lockElsewhere: true, lockHolder: { pid: 4242, ver: '0.1.116' }, cycleMs: 8000 });
  assert.equal(lw.lockWait, true); assert.equal(lw.lockPid, 4242); assert.equal(lw.lockVer, '0.1.116'); assert.equal(lw.phase, 'lock-wait'); assert.equal(lw.errorCode, 'other-process');
  assert.equal(syncHeldView(base, { now, on: true, loopStarted: false, cycleMs: 8000 }).phase, 'not-started');
  assert.equal(syncHeldView(base, { now, on: false, loopStarted: false, cycleMs: 8000 }).phase, 'off');
  // 지난 수집(scanAt) 이전에 남은 건너뜀은 세지 않는다 — 귀속·삭제된 회사의 옛 표지가 남지 않게
  const companies = { a: { ts: now - 500, skipped: 'free-plan' }, b: { ts: now - 5000, skipped: 'no-owner' }, c: { ts: now - 500, skipped: 'no-owner' } };
  const v = syncHeldView({ ...base, companies }, { now, on: true, loopStarted: true, cycleMs: 8000 });
  assert.equal(v.freePlan, 1); assert.equal(v.noOwner, 1);
});

test('④ 진단 — 다른 살아 있는 프로세스가 잠금을 쥐면 단계·잠금 주인(pid·버전)을 상태와 [argo] sync 로그 한 줄로 남긴다(업로드 0)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-lockdiag-'));
  seedRoot(root, { url: fake.url, wsId: 'co-lock' });
  // 살아 있는 pid = 이 시험 프로세스. 앱 업데이트 뒤 남은 옛 프로세스(0.1.116)가 잠금을 쥔 모양
  writeFileSync(join(root, '.sync-process.lock'), JSON.stringify({ pid: process.pid, ts: Date.now(), ver: '0.1.116', since: Date.now() - 86_400_000 }));
  const { status, out } = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 3000, script: 'sync.ensureSync();' });
  assert.equal(status.held.phase, 'lock-wait', JSON.stringify(status.held));
  assert.equal(status.held.lockPid, process.pid);
  assert.equal(status.held.lockVer, '0.1.116');
  assert.equal(status.held.errorCode, 'other-process');
  assert.ok(status.held.lastCycleAt > 0);
  assert.equal(uploads(fake), 0, '잠금 대기 중에는 올리지 않는다(이중 동기화 금지 — 종전과 같음)');
  const lines = out.split('\n').filter((l) => l.startsWith('[argo] sync phase='));
  assert.equal(lines.length, 1, `바뀔 때만 한 줄(주기마다 반복하지 않는다): ${lines.join(' | ')}`);
  assert.match(lines[0], new RegExp(`phase=lock-wait err=other-process plan=- lock=pid:${process.pid}/v0\.1\.116 noOwner=0 foreign=0 free=0`));
  assert.equal(/u1|co-lock|h\.p\.s|rt-0/.test(lines[0]), false, '계정 id·회사 id·토큰을 싣지 않는다');
});

test('⑤ 진단 — 정상 동기화는 단계 idle·오류 없음, 로그에 plan=pro', async () => {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-idlediag-'));
  seedRoot(root, { url: fake.url, wsId: 'co-ok' });
  const { status, out } = await runChild({ root, env: { ARGO_SYNC_CYCLE_MS: '500' }, waitMs: 3000, script: 'sync.ensureSync();' });
  assert.ok(['idle', 'syncing', 'plan-check'].includes(status.held.phase), status.held.phase);
  assert.equal(status.held.errorCode, '');
  assert.ok(out.split('\n').some((l) => /^\[argo\] sync phase=idle err=- plan=pro lock=- /.test(l)), out.slice(-1500));
});

test('① /auth/confirm(공개 GET·PKCE 없음)은 게스트 회사를 귀속하지 않는다 — 교차 사이트 링크로 공격자 계정에 넘어가지 않게(PR #1183 검수)', async () => {
  const fake = await startFakeSupabase({ plan: 'pro', userId: 'u-attacker' }); fakes.push(fake);
  fake.fault = (req, path) => (path === '/auth/v1/verify' ? { status: 200, body: {
    access_token: 'h.p.s', refresh_token: 'rt-9', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'u-attacker', email: 'a@example.test', aud: 'authenticated', role: 'authenticated' },
  } } : null);
  const root = await mkdtemp(join(tmpdir(), 'argo-confirm-noclaim-'));
  mkdirSync(join(root, 'guest-co'), { recursive: true });
  writeFileSync(join(root, 'guest-co', 'company.json'), JSON.stringify({ id: 'guest-co', name: '게스트 회사', owner: 'captain' }));
  writeFileSync(join(root, '.guest-mode.json'), JSON.stringify({ enabled: true }));
  writeFileSync(join(root, '.device-id'), 'fixture-mac-0001');
  const body = `
const { register } = await import('node:module');
register(${JSON.stringify(new URL('./helpers/next-esm-resolve.mjs', import.meta.url).href)});
const route = await import(${JSON.stringify(new URL('../app/auth/confirm/route.js', import.meta.url).href)});
const { NextRequest } = await import('next/server');
const res = await route.GET(new NextRequest('http://127.0.0.1:3299/auth/confirm?token_hash=th-attacker&type=email', { headers: { host: '127.0.0.1:3299', 'sec-fetch-site': 'cross-site' } }));
process.stdout.write('\\n@@' + JSON.stringify({ status: res.status }) + '\\n');
process.exit(0);`;
  const r = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', body], {
      env: childEnv(root, { NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture', ARGO_SYNC: '0', ARGO_AGENT_LINK: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { err += c; });
    p.on('exit', () => {
      const line = out.split('\n').find((l) => l.startsWith('@@'));
      if (!line) return reject(new Error(`no result\n${out.slice(-1500)}\n${err.slice(-1500)}`));
      resolve(JSON.parse(line.slice(2)));
    });
  });
  assert.ok(fake.count('POST /auth/v1/verify') >= 1, '시험이 실제로 확인 경로를 탔다(가짜 서버가 세션을 줬다)');
  assert.ok(r.status >= 300 && r.status < 400, `리다이렉트(${r.status})`);
  const meta = JSON.parse(readFileSync(join(root, 'guest-co', 'company.json'), 'utf8'));
  assert.equal(meta.ownerId, undefined, '게스트 회사 주인 불변(이 경로에 자동 귀속이 다시 들어오면 실패)');
  assert.equal(existsSync(join(root, '.guest-mode.json')), true, '게스트 표지도 그대로');
});
