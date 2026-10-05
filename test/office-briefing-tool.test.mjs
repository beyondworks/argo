// 에이전트 브리핑 도구(office_briefing) — 유건 10/5: 브리핑은 받는 사람의 내 공간에 모이고, 남에게 온 브리핑은 보이지 않는다.
// DB 함수는 가짜 세션 클라이언트로 대신한다(라이브 DB 호출 0). 세션 모양 = msgr.mjs sessionClient()의 { client, uid }.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { briefingTool, briefingDeps, BODY_CAP } from '../src/gateway/office-briefing.mjs';

const ME = 'owner-uid', ORG = 'org-1';
const real = { ...briefingDeps };
after(() => Object.assign(briefingDeps, real));
const ctx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'dm', orgId: ORG, channelId: 'dm-1', crewId: 'crew-1', uid: ME, wsId: 'w', origin: ME, ...extra });
function table(rows) {
  const q = { filters: [], select() { return q; }, eq(k, v) { q.filters.push((r) => r[k] === v); return q; }, in(k, vs) { q.filters.push((r) => vs.includes(r[k])); return q; },
    then(ok, no) { return Promise.resolve({ data: rows.filter((r) => q.filters.every((f) => f(r))), error: null }).then(ok, no); } };
  return q;
}
function fake({ error = null, members = { 'dm-1': [ME], 'pub-1': [ME, 'm2'] } } = {}) {
  const calls = [];
  const client = {
    from: (t) => t === 'msgr_channel_members' ? table(Object.entries(members).flatMap(([ch, ids]) => ids.map((id) => ({ channel_id: ch, member_kind: 'user', member_id: id }))))
      : table([{ org_id: ORG, user_id: ME, role: 'owner', removed_at: null }, { org_id: ORG, user_id: 'm2', role: 'member', removed_at: null }]),
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (error) return { data: null, error: { message: error } };
      if (name === 'office_briefing_write') return { data: { id: args.p_data.id, title: args.p_data.title, org_wide: args.p_data.recipient === 'org' }, error: null };
      if (name === 'office_briefing_list') return { data: [{ id: 'b1', title: '오전 브리프', org_name: 'Lean-AX', org_wide: false, author_name: '페퍼', created_at: '2026-10-05T00:00:00Z' }], error: null };
      if (name === 'office_briefing_get') return { data: { id: 'b1', title: '오전 브리프', org_name: 'Lean-AX', org_wide: false, author_name: '페퍼', created_at: '2026-10-05T00:00:00Z', body: '## 오늘' }, error: null };
      return { data: null, error: { message: 'unknown' } };
    },
  };
  briefingDeps.session = async () => ({ client, uid: ME });
  briefingDeps.newId = () => 'new-id';
  return calls;
}

test('쓰기: 기본은 주인에게, 작성자는 이 에이전트 이름, 지금 대화의 조직으로', async () => {
  const calls = fake();
  const out = await briefingTool({ action: 'brief_add', title: '오전 브리프', body: '## 오늘', kind: 'daily', period: '2026-10-05' }, { ctx: ctx(), crew: '페퍼', ownerId: ME });
  const w = calls.find((c) => c.name === 'office_briefing_write');
  assert.equal(w.args.p_org, ORG); assert.equal(w.args.p_action, 'briefing.create');
  assert.deepEqual({ ...w.args.p_data, id: undefined }, { id: undefined, title: '오전 브리프', body: '## 오늘', kind: 'daily', period: '2026-10-05', recipient: undefined, author_kind: 'agent', author_name: '페퍼' });
  assert.match(out, /주인의 오피스 '내 공간 > 브리핑'/);
});

test('쓰기: recipient=org는 조직 전체로, 개인 공간 대화에서는 조직 전체로 보낼 수 없다', async () => {
  const calls = fake();
  assert.match(await briefingTool({ action: 'brief_add', title: '주간', recipient: 'org' }, { ctx: ctx(), crew: '페퍼', ownerId: ME }), /조직 구성원 모두의/);
  assert.equal(calls.at(-1).args.p_data.recipient, 'org');
  const before = calls.length;
  assert.match(await briefingTool({ action: 'brief_add', title: '주간', recipient: 'org' }, { ctx: ctx({ orgId: null }), crew: '페퍼', ownerId: ME }), /조직 채널이나 조직 안 1:1에서만/);
  assert.equal(calls.length, before, '서버를 부르지 않는다');
});

test('쓰기: 본문 32KB를 넘으면 서버를 부르지 않고 줄이라고 한다', async () => {
  const calls = fake();
  assert.match(await briefingTool({ action: 'brief_add', title: 't', body: 'x'.repeat(BODY_CAP + 1) }, { ctx: ctx(), ownerId: ME }), /너무 길다/);
  assert.equal(calls.filter((c) => c.name === 'office_briefing_write').length, 0);
});

// 유건: 개인 브리핑을 보고 조직 업무를 한다 — 남이 보는 채널에 주인 브리핑을 올리지 않는다
test('읽기: 주인 혼자 보는 1:1에서만, 여럿이 보는 조직 채널에서는 거절', async () => {
  let calls = fake();
  const list = await briefingTool({ action: 'briefs' }, { ctx: ctx(), ownerId: ME, lang: 'ko' });
  assert.match(list, /오전 브리프 · Lean-AX · 페퍼 .* id=b1/);
  assert.match(await briefingTool({ action: 'brief_read', id: 'b1' }, { ctx: ctx(), ownerId: ME }), /## 오늘/);
  calls = fake();
  const out = await briefingTool({ action: 'briefs' }, { ctx: ctx({ channelKind: 'public', channelId: 'pub-1' }), ownerId: ME });
  assert.match(out, /주인과의 1:1 대화에서만/);
  assert.equal(calls.filter((c) => c.name.startsWith('office_briefing')).length, 0);
});

test('관문: 다른 계정 세션·위임 턴·메신저 밖에서는 쓰지 않는다', async () => {
  fake();
  assert.match(await briefingTool({ action: 'briefs' }, { ctx: ctx(), ownerId: 'someone-else' }), /주인의 계정이 아니라/);
  assert.match(await briefingTool({ action: 'briefs' }, { ctx: { kind: 'msgr-rules' }, ownerId: ME }), /위임 턴/);
  assert.match(await briefingTool({ action: 'briefs' }, { ctx: null, ownerId: ME }), /메신저 대화/);
});

test('서버 거절은 사람이 읽을 한 줄로', async () => {
  fake({ error: 'briefing_forbidden' });
  assert.match(await briefingTool({ action: 'brief_add', title: 't', recipient: 'org' }, { ctx: ctx(), ownerId: ME }), /조직 관리자만/);
  fake({ error: 'briefing_limit' });
  assert.match(await briefingTool({ action: 'brief_add', title: 't' }, { ctx: ctx(), ownerId: ME }), /하루 상한/);
});
