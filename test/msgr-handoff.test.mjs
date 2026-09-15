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

test('도구 넘김 대상은 이름·slug가 겹치면 정확한 ID로 확정한다', () => {
  const ctx = context();
  ctx.peers.unshift({ id: 'foreign', slug: 'beta', display_name: '베타', owner_user_id: 'other', ws_id: 'local' });
  ctx.peers.unshift({ id: 'other-company', slug: 'beta', display_name: '베타', owner_user_id: 'owner', ws_id: 'other' });
  assert.throws(() => stageMessengerHandoff(ctx, { to: 'beta', message: '모호한 대상' }));
  stageMessengerHandoff(ctx, { to: 'b', message: '다음 2' });
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
  return sink.find((t) => t.name === 'send_to_crew')?.handler;
}

function sdkDelegate(ws, ctx) {
  const sink = [];
  makeCrewServer(ws, 'alpha', '알파', [{ slug: 'beta', name: '베타' }], 0, [], ctx, 'ko', [], '', sink);
  return sink.find((t) => t.name === 'delegate')?.handler;
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
    const handler = sdkDelegate(ws, ctx);
    if (handler) assert.match(JSON.stringify(await handler({ to: 'beta', task: '채널 밖에 넘기지 말 것' })), /위임 실패/);
    else assert.equal(ctx.peers?.length ?? 0, 0, '허가된 후보가 없으면 도구 자체가 노출되지 않는다');
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
    if (runner === 'SDK') {
      assert.equal(sdkMail(ws, ctx), undefined, '허가된 후보가 없으면 메신저 도구가 노출되지 않는다');
    } else {
      const result = await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'beta', message: '채널 요청' }], { mirrorCtx: ctx });
      assert.match(JSON.stringify(result), /실패/);
    }
    assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'beta')).catch(() => []), []);
  });
}


test('자연문 동명이인 멘션은 팬아웃하지 않고 도구의 정확한 ID만 남는다', async () => {
  const { mentionsIn } = await import('../src/gateway/msgr.mjs');
  const candidates = [...peers, { id: 'other-beta', slug: 'other', display_name: '베타' }];
  assert.deepEqual(mentionsIn('@베타 다음', candidates, 'a'), []);
  assert.deepEqual(mentionsIn('@베타 다음', peers, 'a'), [{ kind: 'crew', id: 'b' }]);
});

test('메신저 도구 넘김은 허가된 조직의 원격 동료 UUID 또는 유일한 slug를 받는다', () => {
  const ctx = context();
  ctx.peers.push({ id: 'remote-id', slug: 'remote', display_name: '원격', owner_user_id: 'remote-owner', ws_id: 'remote-ws' });
  stageMessengerHandoff(ctx, { to: 'remote', cc: ['beta'], message: '같은 DM에서 답해줘' });
  assert.equal(ctx.handoffs[0].to.id, 'remote-id');
  assert.equal(ctx.handoffs[0].cc[0].id, 'b');
  stageMessengerHandoff(ctx, { to: 'remote-id', message: 'ID로 지정' });
  assert.equal(ctx.handoffs[1].to.id, 'remote-id');
});

test('소유자가 다른 동명 slug는 명시적인 UUID 없이는 넘기지 않는다', () => {
  const ctx = context();
  ctx.peers.push({ id: 'remote-beta', slug: 'beta', display_name: '다른 베타', owner_user_id: 'remote-owner', ws_id: 'remote' });
  assert.throws(() => stageMessengerHandoff(ctx, { to: 'beta', message: '모호함' }));
  stageMessengerHandoff(ctx, { to: 'remote-beta', message: '정확한 대상' });
  assert.equal(ctx.handoffs[0].to.id, 'remote-beta');
});

test('CLI 메신저 쪽지는 로컬 파일에 없는 원격 동료 UUID를 허가된 문맥으로 넘긴다', async () => {
  const ws = await setup(); const ctx = context();
  ctx.peers.push({ id: 'remote-only', slug: 'remote-only', display_name: '원격 전담', owner_user_id: 'other', ws_id: 'other-machine' });
  const result = await runDirectives(ws, 'alpha', [{ action: 'mail', to: 'remote-only', cc: ['b'], message: '이 DM에서 알려줘' }], { mirrorCtx: ctx });
  assert.doesNotMatch(JSON.stringify(result), /실패/);
  assert.equal(ctx.handoffs[0].to.id, 'remote-only');
  assert.equal(ctx.handoffs[0].cc[0].id, 'b');
  assert.deepEqual(await readdir(join(paths(ws).root, 'mail', 'remote-only')).catch(() => []), []);
});

test('DM 넘김 힌트는 1:1 전달 계약을 안내하고 옛 "같은 DM에 남긴다" 문구를 남기지 않는다', async () => {
  const { messengerHandoffHint } = await import('../src/gateway/msgr-handoff.mjs');
  const ko = messengerHandoffHint('ko');
  const en = messengerHandoffHint('en');
  assert.match(ko, /사용자와 그 동료의 1:1 대화로 전달되고 동료는 거기서 답한다/);
  assert.match(ko, /동료의 답을 기다리거나 대신 답하지 마라/);
  assert.doesNotMatch(ko, /동료의 답변도 이 DM에 남겨라/);
  assert.match(en, /forwards that request to your user's 1:1 DM with that colleague, who replies there/);
  assert.doesNotMatch(en, /keep their reply in this DM/);
});

test('CC 줄 분류는 독립 줄만 인정하고 인용·코드의 CC는 지시로 승격하지 않는다', async () => {
  const { messengerRecipientText } = await import('../src/gateway/msgr-handoff.mjs');
  const body = '@알파 실행\nCC: @베타\n> CC: @인용\n```text\nCC: @코드\n```\n설명 CC: @본문\n참조: @감사';
  const result = messengerRecipientText(body);
  assert.equal(result.cc, '@베타\n@감사');
  assert.doesNotMatch(result.to, /@인용/);
  assert.doesNotMatch(result.to, /@코드/);
});

// ── 부재중 안내(유건 요구 2026-09-15: 위임했으면 상대가 깨어나 일해야 한다) — 상대 소유자 PC가 꺼져 있으면 넘김이 조용히 기다리던 자리 ──
test('넘김 줄: 상대 심박이 90초를 넘거나 없으면 "(부재중 — 온라인이 되면 실행)", 온라인·조회 불가는 표시 없음, en 문구', async () => {
  const { renderMessengerHandoffs, HANDOFF_AWAY_MS } = await import('../src/gateway/msgr-handoff.mjs');
  const now = () => 1_000_000_000_000;
  const iso = (agoMs) => new Date(now() - agoMs).toISOString();
  const ctx = { handoffs: [{ to: { id: 'b', display_name: '베타' }, cc: [], message: '다음' }, { to: { id: 'c', display_name: '감마' }, cc: [{ display_name: '델타' }], message: '검토' }] };
  assert.equal(renderMessengerHandoffs(ctx), '@베타\n다음\n\n@감마\n검토\n(CC: 델타)', '기본(심박 미조회)은 종전 그대로');
  assert.equal(renderMessengerHandoffs(ctx, { seenAt: { b: iso(HANDOFF_AWAY_MS + 1), c: iso(10_000) }, now }), '@베타 (부재중 — 온라인이 되면 실행)\n다음\n\n@감마\n검토\n(CC: 델타)');
  assert.equal(renderMessengerHandoffs(ctx, { seenAt: { b: null }, now }).split('\n')[0], '@베타 (부재중 — 온라인이 되면 실행)', '심박 없음 = 부재중');
  assert.equal(renderMessengerHandoffs(ctx, { seenAt: { b: iso(HANDOFF_AWAY_MS) }, now }).split('\n')[0], '@베타', '정확히 90초는 온라인');
  assert.equal(renderMessengerHandoffs(ctx, { seenAt: {}, now }).split('\n')[0], '@베타', '키 없음(조회 못 함) = 표시 없음');
  assert.equal(renderMessengerHandoffs(ctx, { seenAt: { b: null }, now, lang: 'en' }).split('\n')[0], '@베타 (away — runs when back online)');
});
test('배선: messengerReply가 넘김 대상 심박을 한 번 조회해 렌더에 넘기고, 두 호출부가 db·lang을 전달한다', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/gateway/msgr.mjs', import.meta.url), 'utf8');
  assert.match(src, /async function messengerReply\(ctx, text, \{ db = null, lang = 'ko' \} = \{\}\)/);
  assert.match(src, /db\?\.crewSeen \? await db\.crewSeen\(handoffs\.map\(\(h\) => h\.to\.id\)\)\.catch\(\(\) => null\) : null/, '조회 실패는 표시 생략');
  assert.match(src, /renderMessengerHandoffs\(\{ handoffs \}, \{ seenAt, lang \}\)/);
  assert.equal((src.match(/await messengerReply\(ctx, [a-z.]+, \{ db, lang \}\)/g) ?? []).length, 2, '후속 실행·드레인 두 호출부');
  assert.match(src, /async crewSeen\(ids\)/);
});
