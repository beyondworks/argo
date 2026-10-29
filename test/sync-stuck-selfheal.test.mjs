// 고객 C 메인 PC(2026-10-29~30): 0.1.120에서도 동기화 요청이 운영에 한 건도 오지 않았다. 같은 데이터 폴더 상태를 가짜 Supabase 위에서 재현해
// 두 영구 정지 경로를 찾았다 — ① 남은 .sync-credentials.json(옛 페어링)의 주소·오너로 동기화가 빠짐 ② 미래 시각 잠금(시계가 앞서던 때)이 영영 신선.
// 이 시험은 그 상태에서도 동기화가 우리 클라우드로 올라가는지(업로드 요청)를 본다. 자식 프로세스 + 실제 supabase-js(test/helpers/sync-child.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, runSyncChild, srcUrl, childEnv } from './helpers/sync-child.mjs';
import { syncDiagTag } from '../src/sync.mjs';
import { withSyncDiag } from '../src/app-gate.mjs';

const fakes = [];
after(async () => { for (const f of fakes) await f.close(); });
const uploads = (fake) => fake.hits.filter((h) => /^POST \/storage\/v1\/object\/companies\/u1\/co-1234\//.test(h.k)).length;

async function setup() {
  const fake = await startFakeSupabase({ plan: 'pro' }); fakes.push(fake);
  const root = await mkdtemp(join(tmpdir(), 'argo-selfheal-'));
  seedRoot(root, { url: fake.url });
  // 설치본은 공개 설정이 빌드에 박혀 있다 — node 시험에서는 같은 값을 env로 준다(serviceCredsAllowed가 글자 그대로 읽는 자리)
  return { fake, root, env: { ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fake.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' } };
}

test('남은 페어링 자격 파일(다른 주소·다른 오너)이 있어도 호스티드 앱은 기기 세션으로 우리 클라우드에 올린다', { timeout: 60_000 }, async () => {
  const { fake, root, env } = await setup();
  writeFileSync(join(root, '.sync-credentials.json'), JSON.stringify({ url: 'http://127.0.0.1:9', key: 'stale', owner: 'someone-else' }));
  const { status } = await runSyncChild({ root, env, waitMs: 4000 });
  assert.equal(status.plan, 'pro', `요금제가 이 계정으로 판정돼야 한다(남의 오너로 물으면 무료로 굳는다): ${JSON.stringify(status)}`);
  assert.ok(uploads(fake) > 0, `업로드 0건 — 동기화가 자격 파일 쪽으로 빠졌다. 받은 요청: ${fake.hits.map((h) => h.k).join(', ')}`);
});

test('같은 주소·다른 오너의 남은 자격 파일 — 판정 대상이 남의 오너로 새지 않는다(영구 무료 방지)', { timeout: 60_000 }, async () => {
  const { fake, root, env } = await setup();
  writeFileSync(join(root, '.sync-credentials.json'), JSON.stringify({ url: fake.url, key: 'stale', owner: 'someone-else' }));
  const { status } = await runSyncChild({ root, env, waitMs: 4000 });
  assert.equal(status.plan, 'pro', JSON.stringify(status));
  assert.ok(uploads(fake) > 0, `업로드 0건: ${fake.hits.map((h) => h.k).join(', ')}`);
  assert.ok(fake.hits.every((h) => h.auth !== 'Bearer stale'), '남은 서비스 키로 요청을 보냈다');
});

test('미래 시각이 찍힌 동기화 잠금(살아 있는 pid)은 회수한다 — 그 시각까지 멈추지 않는다', { timeout: 60_000 }, async () => {
  const { fake, root, env } = await setup();
  writeFileSync(join(root, '.sync-process.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() + 86_400_000 }));
  const { status } = await runSyncChild({ root, env, waitMs: 4000 });
  assert.equal(status.lastError, '', JSON.stringify(status));
  assert.ok(uploads(fake) > 0, `업로드 0건 — 잠금 대기에 묶였다: ${fake.hits.map((h) => h.k).join(', ')}`);
});

test('살아 있는 다른 프로세스의 현재 잠금은 종전처럼 존중한다(이중 동기화 금지)', { timeout: 60_000 }, async () => {
  const { fake, root, env } = await setup();
  writeFileSync(join(root, '.sync-process.lock'), JSON.stringify({ pid: process.pid, ts: Date.now() + 5_000 }));
  const { status } = await runSyncChild({ root, env, waitMs: 3000 });
  assert.match(status.lastError, /다른 프로세스/);
  assert.equal(uploads(fake), 0);
});

test('데몬 리스에 남의 미래 시각 기록이 있으면 첫 판정에서 가져간다', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-lease-future-'));
  writeFileSync(join(root, '.gateway.lock'), JSON.stringify({ owner: 'ghost', ts: Date.now() + 86_400_000 }));
  const script = `const { daemonLease } = await import(${JSON.stringify(srcUrl('lock.mjs'))});
const l = daemonLease('gateway'); await l.ready; process.stdout.write('@@' + l.isLeader() + '\\n'); process.exit(0);`;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; let e = ''; p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { e += c; });
    p.on('exit', () => (o.includes('@@') ? resolve(o) : reject(new Error(e))));
  });
  assert.match(out, /@@true/);
});

test('원격 진단 꼬리표 — 단계·오류·잠금·건너뜀·남은 자격 파일만, 식별자 없음', () => {
  assert.equal(syncDiagTag({ phase: 'lock-wait', errorCode: 'other-process', lockWait: true, lockVer: '0.1.119', noOwner: 2, foreignOwner: 0 }, { credsFileIgnored: true }),
    'sync/lock-wait.other-process.L0.1.119.o2f0.c1');
  assert.equal(syncDiagTag({ phase: 'idle', errorCode: '' }), 'sync/idle.-.-.o0f0.c0');
  assert.equal(syncDiagTag({ phase: 'x y/z<script>', errorCode: 'a b' }), 'sync/xyzscript.ab.-.o0f0.c0', '헤더를 깨는 글자는 지운다');
});

test('진단 꼬리표는 기존 X-Client-Info 뒤에 붙고, 없거나 실패하면 요청을 그대로 보낸다', async () => {
  let seen = null;
  const base = async (_u, init) => { seen = new Headers(init.headers).get('x-client-info'); return new Response('null'); };
  await withSyncDiag(base, () => 'sync/idle.-.-.o0f0.c0')('http://x', { headers: { 'X-Client-Info': 'supabase-js/2 argo/0.1.121' } });
  assert.equal(seen, 'supabase-js/2 argo/0.1.121 sync/idle.-.-.o0f0.c0');
  await withSyncDiag(base, () => null)('http://x', { headers: { 'X-Client-Info': 'a' } });
  assert.equal(seen, 'a');
  await withSyncDiag(base, () => { throw new Error('x'); })('http://x', { headers: { 'X-Client-Info': 'b' } });
  assert.equal(seen, 'b');
});

// 0.1.121 분리 검수(높음): 옛 설치본은 남은 자격 파일의 주소(A)로 맞춘 기록(base)을 남겼다. 고친 판이 우리 클라우드(B)로 돌아오며 그 base로 비교하면
// A에만 올린 파일을 'B에서 지워짐'으로 읽어 로컬에서 지웠다. 기록에 목적지 표지가 없고 쓰지 않는 자격 파일이 남았거나, 표지가 지금과 다르면 비우고 합치기만 한다.
test('목적지가 바뀐 옛 기록(base) — 로컬 파일을 지우지 않고 새 목적지로 올린다', { timeout: 90_000 }, async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const fakeA = await startFakeSupabase({ plan: 'pro' }); fakes.push(fakeA);
  const fakeB = await startFakeSupabase({ plan: 'pro' }); fakes.push(fakeB);
  // 다른 기기가 B에 같은 회사를 먼저 올린다(매니페스트 있음, only-b.md만)
  const other = await mkdtemp(join(tmpdir(), 'argo-target-other-'));
  seedRoot(other, { url: fakeB.url });
  writeFileSync(join(other, '.device-id'), 'fixture-other-0002');
  writeFileSync(join(other, 'co-1234', 'only-b.md'), 'from other device');
  await runSyncChild({ root: other, env: { ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fakeB.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' }, waitMs: 4000 });
  assert.ok(fakeB.store.size > 0, 'B에 다른 기기 사본이 올라가야 시험이 성립한다');
  // 이 기기는 A로 맞춘 기록을 갖고 있다(only-a.md가 base에 있음)
  const root = await mkdtemp(join(tmpdir(), 'argo-target-mine-'));
  seedRoot(root, { url: fakeA.url });
  writeFileSync(join(root, 'co-1234', 'only-a.md'), 'only uploaded to A');
  await runSyncChild({ root, env: { ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fakeA.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' }, waitMs: 4000 });
  const stPath = join(root, 'co-1234', '.sync-state.json');
  const st = JSON.parse(readFileSync(stPath, 'utf8'));
  assert.ok(st.files?.['only-a.md'], `A 기준 기록이 있어야 한다: ${Object.keys(st.files ?? {})}`);
  delete st.target; writeFileSync(stPath, JSON.stringify(st)); // 옛 설치본 기록(표지 없음)
  writeFileSync(join(root, '.sync-credentials.json'), JSON.stringify({ url: fakeA.url, key: 'stale', owner: 'u1' })); // 옛 판이 쓰던 남은 자격 파일
  const dev = JSON.parse(readFileSync(join(root, '.device-session.json'), 'utf8'));
  writeFileSync(join(root, '.device-session.json'), JSON.stringify({ ...dev, url: fakeB.url }), { mode: 0o600 });
  await runSyncChild({ root, env: { ARGO_SYNC_CYCLE_MS: '1000', NEXT_PUBLIC_SUPABASE_URL: fakeB.url, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-fixture' }, waitMs: 5000 });
  assert.ok(existsSync(join(root, 'co-1234', 'only-a.md')), 'A에만 올렸던 로컬 파일이 지워졌다');
  assert.ok([...fakeB.store.keys()].some((k) => k.endsWith('co-1234/only-a.md')), `B로 올라가야 한다: ${[...fakeB.store.keys()].join(', ')}`);
  assert.ok(existsSync(join(root, 'co-1234', 'only-b.md')), '다른 기기 파일도 받아야 한다');
  assert.equal(JSON.parse(readFileSync(stPath, 'utf8')).target?.length, 16, '기록에 목적지 표지가 남는다');
});
