import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-channel-handoff-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { runDirectives } = await import('../src/cli-directives.mjs');
const { makeCrewServer } = await import('../src/chat.mjs');
const { stageMessengerHandoff } = await import('../src/gateway/msgr-handoff.mjs');
const peers = [{ id: 'a', slug: 'alpha', display_name: '알파' }, { id: 'b', slug: 'beta', display_name: '베타' }];
let count = 0;
async function setup() {
  const ws = `handoff-${++count}`;
  await createCompany(ws, '검수', 'alpha');
  await mkdir(paths(ws).agents, { recursive: true });
  for (const p of peers) await writeFile(join(paths(ws).agents, `${p.slug}.md`), `---\nname: ${p.display_name}\nslug: ${p.slug}\n---\n`);
  return ws;
}

test('도구 넘김 대상은 이름·slug가 겹쳐도 같은 소유자·회사 ID로 확정한다', () => {
  const ctx = context();
  ctx.peers.unshift({ id: 'foreign', slug: 'beta', display_name: '베타', owner_user_id: 'other', ws_id: 'local' });
  ctx.peers.unshift({ id: 'other-company', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: 'other' });
  stageMessengerHandoff(ctx, { to: 'beta', message: '다음 2' });
  assert.equal(ctx.handoffs[0].to.id, 'b');
  assert.throws(() => stageMessengerHandoff(ctx, { to: 'alpha', message: '나에게' }));
});

test('채널 넘김은 동일 요청을 중복하지 않고 본문·팬아웃 상한을 지킨다', () => {
  const ctx = context();
  stageMessengerHandoff(ctx, { to: 'beta', message: '2' });
  stageMessengerHandoff(ctx, { to: 'beta', message: '2' });
  assert.equal(ctx.handoffs.length, 1);
  assert.throws(() => stageMessengerHandoff(ctx, { to: 'beta', message: 'x'.repeat(6001) }));
  stageMessengerHandoff(ctx, { to: 'beta', message: '추가 맥락' });
  assert.throws(() => stageMessengerHandoff(ctx, { to: 'beta', message: '세 번째' }));
  assert.equal(ctx.handoffs.length, 2);
});

for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 메신저 위임의 자식 턴도 일반 쪽지로 새지 않는다`, async () => {
    const ws = await setup(); const ctx = { kind: 'msgr-rules', orgSlug: 'org' };
    const result = runner === 'SDK'
      ? await sdkMail(ws, ctx)({ to: 'beta', message: '위임 안쪽 쪽지' })
      : await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'beta', message: '위임 안쪽 쪽지' }], { mirrorCtx: ctx });
    assert.match(JSON.stringify(result), /실패/);
    assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'beta')).catch(() => []), []);
  });
  test(`${runner}: 일반 쪽지는 기존 우편 큐에 배달한다`, async () => {
    const ws = await setup();
    if (runner === 'SDK') await sdkMail(ws, null)({ to: 'beta', message: '일반 쪽지' });
    else await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'beta', message: '일반 쪽지' }]);
    assert.equal((await readdir(join(paths(ws).root, 'mail', 'beta'))).length, 1);
  });
}
function context() { return { kind: 'msgr', orgId: 'org', channelId: 'channel', crewId: 'a', threadRoot: 10, uid: 'owner', wsId: 'local', peers: peers.map((p) => ({ ...p, owner_user_id: 'owner', ws_id: 'local' })), handoffs: [] }; }
function sdkMail(ws, ctx) {
  const sink = [];
  makeCrewServer(ws, 'alpha', '알파', [{ slug: 'beta', name: '베타' }], 0, [], ctx, 'ko', [], '', sink);
  return sink.find((t) => t.name === 'send_to_crew').handler;
}

function sdkDelegate(ws, ctx) {
  const sink = [];
  makeCrewServer(ws, 'alpha', '알파', [{ slug: 'beta', name: '베타' }], 0, [], ctx, 'ko', [], '', sink);
  return sink.find((t) => t.name === 'delegate').handler;
}

test('메신저 delegate는 로컬 자식 턴 대신 정확한 채널 넘김을 준비한다', async () => {
  const ws = await setup(); const ctx = context();
  const result = await sdkDelegate(ws, ctx)({ to: 'beta', task: '근거를 조사하고 이 채널에 보고' });
  assert.match(JSON.stringify(result), /아직 결과는 없다/);
  assert.equal(ctx.handoffs.length, 1);
  assert.equal(ctx.handoffs[0].to.id, 'b');
  assert.equal(ctx.handoffs[0].message, '근거를 조사하고 이 채널에 보고');
  assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'beta')).catch(() => []), []);
});

test('메신저 delegate는 채널 밖 크루와 불완전 문맥을 로컬 실행으로 우회하지 않는다', async () => {
  const ws = await setup();
  for (const ctx of [{ ...context(), peers: [] }, { kind: 'msgr' }, { kind: 'msgr-rules' }]) {
    const result = await sdkDelegate(ws, ctx)({ to: 'beta', task: '채널 밖에 넘기지 말 것' });
    assert.match(JSON.stringify(result), /위임 실패/);
    assert.equal(ctx.handoffs?.length ?? 0, 0);
  }
});
for (const runner of ['SDK', 'CLI']) {
  test(`${runner}: 메신저 쪽지는 채널 넘김으로 수집하고 일반 우편 큐를 만들지 않는다`, async () => {
    const ws = await setup(); const ctx = context();
    if (runner === 'SDK') await sdkMail(ws, ctx)({ to: 'beta', message: '1 다음은 2' });
    else await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'beta', message: '1 다음은 2' }], { mirrorCtx: ctx });
    assert.equal(ctx.handoffs.length, 1);
    assert.equal(ctx.handoffs[0].to.id, 'b');
    assert.equal(ctx.handoffs[0].message, '1 다음은 2');
    assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'beta')).catch(() => []), []);
  });
  test(`${runner}: 메신저 문맥이 불완전해도 일반 쪽지로 우회하지 않는다`, async () => {
    const ws = await setup(); const ctx = { kind: 'msgr', channelId: 'channel' };
    const result = runner === 'SDK'
      ? await sdkMail(ws, ctx)({ to: 'beta', message: '채널 요청' })
      : await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'beta', message: '채널 요청' }], { mirrorCtx: ctx });
    assert.match(JSON.stringify(result), /실패/);
    assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'beta')).catch(() => []), []);
  });
}


test('자연문 동명이인 멘션은 팬아웃하지 않고 도구의 정확한 ID만 남는다', async () => {
  const { mentionsIn } = await import('../src/gateway/msgr.mjs');
  const candidates = [...peers, { id: 'other-beta', slug: 'other', display_name: '베타' }];
  assert.deepEqual(mentionsIn('@베타 다음', candidates, 'a'), []);
  assert.deepEqual(mentionsIn('@베타 다음', peers, 'a'), [{ kind: 'crew', id: 'b' }]);
});
