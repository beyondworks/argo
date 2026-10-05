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
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
const wire = (db, over = {}) => Object.assign(M.firedDeps, { session: async () => ({ uid: UID, db }), load: async () => ({ ownerId: UID }), seen: new Map([[WS, new Map([['luna', null], ['jun', null]])]]), log: () => {}, ...over });

test('F1. 해고하면 카드는 .archive로 가고, 그 slug의 파견 행 분리가 한 번 나가며 기준에서 slug가 빠진다', async () => {
  await seed('luna'); await seed('jun');
  const asked = []; wire({ async detachActiveCrews(...a) { asked.push(a); return ['a1', 'ap']; } });
  const res = await fire('luna');
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(!(await readdir(dir)).includes('luna.md'), '카드는 보관함으로');
  assert.ok(await until(() => asked.length >= 1), '분리 호출이 나간다');
  await new Promise((r) => setTimeout(r, 30));
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
});

test('F3. 로그인이 없거나 DB가 실패하거나 소유자가 달라도 해고는 그대로 되고, 기준은 남아 다음 미러 틱이 처리한다', async () => {
  for (const [name, over, db] of [['세션 없음', { session: async () => null }, {}], ['세션 오류', { session: async () => { throw new Error('offline'); } }, {}],
    ['DB 실패', {}, { async detachActiveCrews() { throw new Error('boom'); } }], ['다른 소유자', { load: async () => ({ ownerId: 'someone-else' }) }, { async detachActiveCrews() { throw new Error('호출되면 안 된다'); } }]]) {
    await seed('fragile');
    wire(db, over);
    const res = await fire('fragile');
    assert.equal(res.status, 200, name);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(M.firedDeps.seen.get(WS).has('luna'), `${name}: 기준을 그대로 둔다 — 다음 미러 틱이 카드가 사라진 변화로 처리`);
  }
});

test('F4. 없는 크루를 해고하면 오류 그대로이고 분리 호출은 나가지 않는다', async () => {
  const asked = []; wire({ async detachActiveCrews(...a) { asked.push(a); return []; } });
  const res = await fire('nobody');
  assert.equal(res.status, 400);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(asked, []);
});
