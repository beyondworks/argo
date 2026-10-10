// 해고 라우트(DELETE /api/companies/[ws]/agents/[slug])가 메신저 파견 행을 바로 분리한다(검수 #fix-cross M3a) —
// 15초 미러는 이 프로세스가 본 카드 변화로만 해고를 알아서, 해고 직후 재시작하거나 미러가 아직 안 돈 틈에는 놓친다.
//  · 해고가 되면 그 slug의 행(조직·개인)을 분리하는 호출이 한 번 나가고, 기준(cardSeen)에서 slug가 빠진다
//  · 응답은 분리 호출을 기다리지 않는다(느려도·멈춰도 해고는 끝난다), 실패·로그인 없음·카드 없음은 해고 결과에 영향이 없다
// 라이브 DB 0 — 세션·db는 가짜. 라우트는 AUTH off(로컬 1인 모드)에서 실제로 부른다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-fire-route-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url)); // 라우트 직접 호출(app/auth.mjs의 next/headers)
const { DELETE } = await import('../app/api/companies/[ws]/agents/[slug]/route.js');
const M = await import('../src/gateway/msgr.mjs');
const { paths } = await import('../src/workspace.mjs');
const WS = 'ws-fire', UID = '11111111-1111-4111-8111-111111111111';
const saved = { ...M.firedDeps };
after(() => Object.assign(M.firedDeps, saved));
const dir = paths(WS).agents;
await mkdir(dir, { recursive: true });
const seed = async (slug) => writeFile(join(dir, `${slug}.md`), `---\nname: ${slug}\nslug: ${slug}\nrole: r\n---\n\n# ${slug}\n`);
const fire = (slug) => DELETE(new Request('http://localhost/x', { method: 'DELETE' }), { params: Promise.resolve({ ws: WS, slug }) });
/** 이벤트 루프를 몇 바퀴 돌려 남은 비동기 꼬리(마이크로태스크)가 끝나게 한다 — 시간이 아니라 바퀴 수라 부하와 무관 */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const until = async (fn) => { for (let i = 0; i < 500; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
// 라우트는 분리를 동적 import 뒤에 응답과 떼어 부르고, detachFiredCrew는 시작할 때 firedDeps를 잡는다. 그 import는 로더 훅을 거쳐 부하에 따라 settle 바퀴 수보다
// 늦게 끝날 수 있다 — 시험이 먼저 끝나면 꼬리가 다음 시험이 바꾼 firedDeps로 돌아 남의 asked에 찍히고(2026-10-09 #915 CI F4: F3 마지막 경우의 'fragile'),
// 앞 시험의 '분리 0번' 단언은 아직 돌지 않은 호출을 센 셈이 된다. 그래서 의존성을 잡은 첫 걸음(session 호출)을 세고, 해고한 시험은 그것을 기다린다.
let entered = 0;
const wire = (db, over = {}) => {
  entered = 0;
  const deps = { session: async () => ({ uid: UID, db }), load: async () => ({ ownerId: UID }), seen: new Map([[WS, new Map([['luna', null], ['jun', null]])]]), log: () => {}, ...over };
  const session = deps.session; deps.session = (...a) => { entered += 1; return session(...a); };
  return Object.assign(M.firedDeps, deps);
};
/** 라우트가 띄운 분리가 이 시험의 의존성을 잡을 때까지 기다린다 — 그 뒤 남은 꼬리는 이 시험의 asked·seen만 만진다 */
const detachStarted = async () => assert.ok(await until(() => entered >= 1), '라우트가 분리를 시작한다');

test('F1. 해고하면 카드는 .archive로 가고, 그 slug의 파견 행 분리가 한 번 나가며 기준에서 slug가 빠진다', async () => {
  await seed('luna'); await seed('jun');
  const asked = []; wire({ async detachActiveCrews(...a) { asked.push(a); return ['a1', 'ap']; } });
  const res = await fire('luna');
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(!(await readdir(dir)).includes('luna.md'), '카드는 보관함으로');
  await detachStarted();
  assert.ok(await until(() => asked.length >= 1), '분리 호출이 나간다');
  assert.ok(await until(() => !M.firedDeps.seen.get(WS).has('luna')), '분리 뒤 기준에서 slug가 빠진다(고정 대기가 아니라 조건 대기 — 카드 폴더를 한 번 더 읽는 시간은 부하에 따라 다르다, 4차 L-6)');
  await settle();
  assert.deepEqual(asked, [[UID, WS, 'luna']], '그 slug만, 한 번');
  assert.deepEqual([...M.firedDeps.seen.get(WS).keys()], ['jun'], '분리한 slug는 기준에서 뺀다 — 다른 크루는 그대로');
});

test('F2. 응답은 분리 호출을 기다리지 않는다 — 호출이 영영 끝나지 않아도 해고는 끝난다', async () => {
  await seed('stuck');
  wire({ detachActiveCrews: () => new Promise(() => {}) });
  const started = Date.now();
  const res = await fire('stuck');
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 1000);
  assert.ok(!(await readdir(dir)).includes('stuck.md'));
  await detachStarted(); // 끝나지 않는 분리가 다음 시험의 의존성을 잡지 않게
});

test('F3. 로그인이 없거나 DB가 실패하거나 소유자가 달라도 해고는 그대로 되고, 해고한 slug는 기준에 남아 다음 미러 틱이 처리한다(검수 2차 L-4a)', async () => {
  for (const [name, over, failing, wantCalls] of [['세션 없음', { session: async () => null }, false, 0], ['세션 오류', { session: async () => { throw new Error('offline'); } }, false, 0],
    ['DB 실패', {}, true, 1], ['다른 소유자', { load: async () => ({ ownerId: 'someone-else' }) }, false, 0], ['회사 노드', { load: async () => ({ ownerId: UID, msgr: { nodeOrgId: 'org-x' } }) }, false, 0]]) {
    await seed('fragile');
    const asked = [];
    // 기준에 넣는 것은 해고하는 slug(fragile) — 분리가 안 됐는데 기준에서 빠지면(분리 전 삭제) 미러가 해고를 영영 못 본다
    wire({ async detachActiveCrews(...a) { asked.push(a); if (failing) throw new Error('boom'); return ['a1']; } }, { ...over, seen: new Map([[WS, new Map([['fragile', null], ['jun', null]])]]) });
    const res = await fire('fragile');
    assert.equal(res.status, 200, name);
    assert.ok(!(await readdir(dir)).includes('fragile.md'), `${name}: 해고는 그대로 된다`);
    await detachStarted();
    if (wantCalls) assert.ok(await until(() => asked.length >= wantCalls), `${name}: 분리 호출이 나간다`);
    await settle();
    assert.equal(asked.length, wantCalls, `${name}: 분리 호출 수`);
    assert.deepEqual([...M.firedDeps.seen.get(WS).keys()].sort(), ['fragile', 'jun'], `${name}: 해고한 slug가 기준에 남는다 — 다음 미러 틱이 카드가 사라진 변화로 처리`);
  }
});

test('F4. 없는 크루를 해고하면 오류 그대로이고 분리 호출은 나가지 않는다 — 상태 코드는 구현마다 달라도(400·404) 실패다', async () => {
  const asked = []; wire({ async detachActiveCrews(...a) { asked.push(a); return []; } });
  const res = await fire('nobody');
  assert.ok(!res.ok, `실패 응답 ${res.status}`);
  await settle();
  assert.deepEqual(asked, []);
  assert.equal(entered, 0, '해고가 실패하면 분리를 띄우지도 않는다');
});
