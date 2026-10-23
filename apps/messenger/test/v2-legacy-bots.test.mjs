// 이름 없는 옛 봇(유건 사용 검수 2026-10-23 "정체모를 이상한 이름의 봇들이 너무 많은데", "에이전트가 57명") — src/v2/legacy-bots.mjs·source.mjs CrewBuilder·App 배선.
// 판정은 좁게: slug 'bot-'+16진 12자 + 이름이 비었거나 slug 그대로 + 어느 공간에도 살아 있는 자리 없음. 데이터는 바꾸지 않는다(목록에서만 내린다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { looksLegacyBot, markLegacyBots, splitLegacyBots } from '../src/v2/legacy-bots.mjs';
import { createV2Client } from '../src/v2/source.mjs';
import { DICT } from '../src/i18n.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const ME = 'o';
const ag = (id, o = {}) => ({ id, owner_user_id: ME, slug: id, display_name: id, role_text: null, face: null, hosting: 'local', status: 'active', created_at: '2026-10-01T00:00:00Z', ...o });
const BOT_A = ag('bot-a', { slug: 'bot-0804ccfb168c', display_name: '' });
const BOT_B = ag('bot-b', { slug: 'bot-0804ccfb168d', display_name: 'bot-0804ccfb168d' });
const BOT_NAMED = ag('bot-n', { slug: 'bot-0804ccfb168e', display_name: '헤르메스' });
const BOT_SEATED = ag('bot-s', { slug: 'bot-0804ccfb168f', display_name: '' });
const REAL = ag('real', { slug: 'research', display_name: '리서치' });

/** 표마다 돌려줄 행 + 호출 기록. 자리 조회는 data.msgr2_agent_seats를 그대로 돌려준다(조건은 기록만) */
function fakeRaw(data = {}) {
  const log = [];
  const chain = (entry) => {
    const b = {};
    for (const op of ['select', 'eq', 'neq', 'in', 'is', 'order', 'limit', 'maybeSingle']) b[op] = (...args) => { entry.ops.push([op, ...args]); return b; };
    b.then = (res, rej) => Promise.resolve(data.error?.[entry.table] ? { data: null, error: { message: 'x' } } : { data: data[entry.table] ?? [], error: null, status: 200 }).then(res, rej);
    return b;
  };
  return { log, auth: { getSession: async () => ({ data: { session: { user: { id: ME } } } }) }, from(table) { const e = { table, ops: [] }; log.push(e); return chain(e); }, rpc: async () => ({ data: null, error: null }) };
}

test('판정: slug 모양 + 이름이 비었거나 slug 그대로만 후보 — 이름 붙인 봇·보통 에이전트는 아니다', () => {
  assert.deepEqual([BOT_A, BOT_B, BOT_NAMED, REAL, ag('x', { slug: 'bot-short', display_name: '' }), ag('y', { slug: 'bot-0804CCFB168C', display_name: '' })].map(looksLegacyBot), [true, true, false, false, false, false]);
});

test('표지: 자리가 있는 후보는 아니다, 자리를 모르면(null) 표지를 달지 않는다(숨기지 않는 쪽)', () => {
  const rows = [BOT_A, BOT_SEATED, REAL];
  assert.deepEqual(markLegacyBots(rows, new Set(['bot-s'])).map((a) => !!a._legacy_bot), [true, false, false]);
  assert.deepEqual(markLegacyBots(rows, null).map((a) => !!a._legacy_bot), [false, false, false]);
  const { agents, legacy } = splitLegacyBots(markLegacyBots(rows, new Set()));
  assert.deepEqual([agents.map((a) => a.id), legacy.map((a) => a.id)], [['real'], ['bot-a', 'bot-s']]);
});

test('CrewBuilder(내 에이전트): 후보가 있을 때만 자리를 한 번 본다 — 자리 없는 후보에 표지, 후보가 없으면 자리 조회 0', async () => {
  const raw = fakeRaw({ msgr2_agents: [BOT_A, BOT_B, BOT_NAMED, BOT_SEATED, REAL], msgr2_agent_seats: [{ agent_id: 'bot-s' }] });
  const r = await createV2Client(raw).from('msgr_crews').select('id, display_name').eq('owner_user_id', ME).in('status', ['active', 'available']);
  assert.deepEqual(r.data.filter((a) => a._legacy_bot).map((a) => a.id), ['bot-a', 'bot-b']);
  assert.ok(r.data.some((a) => a.id === 'bot-n') && r.data.some((a) => a.id === 'real'), '이름 있는 봇·보통 에이전트는 그대로');
  const seatQ = raw.log.filter((e) => e.table === 'msgr2_agent_seats');
  assert.equal(seatQ.length, 1, '자리 조회 1번');
  assert.deepEqual(seatQ[0].ops.find(([op]) => op === 'in'), ['in', 'agent_id', ['bot-a', 'bot-b', 'bot-s']]);
  const plain = fakeRaw({ msgr2_agents: [REAL] });
  await createV2Client(plain).from('msgr_crews').select('id').eq('owner_user_id', ME).in('status', ['active']);
  assert.equal(plain.log.filter((e) => e.table === 'msgr2_agent_seats').length, 0, '후보가 없으면 요청 0');
  const failing = fakeRaw({ msgr2_agents: [BOT_A], error: { msgr2_agent_seats: true } });
  const rf = await createV2Client(failing).from('msgr_crews').select('id').eq('owner_user_id', ME).in('status', ['active']);
  assert.equal(rf.data[0]._legacy_bot, undefined, '자리를 못 읽으면 숨기지 않는다');
});

test('CrewBuilder(공간 — 에이전트 추가·파견 후보): 자리 없는 이름 없는 옛 봇은 "파견 전" 목록에서 빠진다', async () => {
  const raw = fakeRaw({ msgr2_agent_seats: [], msgr2_agents: [BOT_A, REAL] });
  const r = await createV2Client(raw).from('msgr_crews').select('id, status').eq('org_id', SPACE).in('status', ['active', 'available']);
  assert.deepEqual(r.data.map((a) => [a.id, a.status]), [['real', 'available']]);
  assert.ok(r.data.every((a) => !('_avail' in a)), '내부 표지는 행에 남기지 않는다');
});

test('App 배선: 레일은 옛 봇을 접힌 "기타(비활성)"로(처음 접힘), 옛 1:1 이름은 "이름 없는 옛 봇", 문구는 ko·en', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /<RailFold id="mine\.legacy" label=\{t\('rail\.agents\.legacy'\)\} count=\{legacyBots\.length\} defaultClosed>/);
  assert.match(app, /legacyBots\.some\(\(g\) => g\.id === id\) \? t\('agent\.legacyBot'\)/);
  assert.match(app, /defaultClosed \? readFold\(foldStore\(\)\)\[id\] === false : initialOpen\(id, foldStore\(\)\)/);
  for (const k of ['rail.agents.legacy', 'agent.legacyBot', 'agent.legacyBot.hint']) assert.ok(DICT[k]?.[0]?.trim() && DICT[k]?.[1]?.trim(), k);
});
