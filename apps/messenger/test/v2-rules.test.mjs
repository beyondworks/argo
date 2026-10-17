// 메신저 v2 화면(U6b)의 순수 규칙 — 옵트인 플래그, 공간 목록 통합, 시스템 글 코드 → 사전 키, 일 카드 상태·자리, @멘션.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Enabled, V2_FLAG_KEY } from '../src/v2/flag.mjs';
import { spaceList, liveSpaceIds, pickStartSpace } from '../src/v2/spaces.mjs';
import { systemLine, LIMIT_KINDS } from '../src/v2/system-text.mjs';
import { workCard, timeline, PHASES } from '../src/v2/work-card.mjs';
import { mentionsOf } from '../src/v2/data.mjs';
import { DICT } from '../src/i18n.js';
import { WORK_ERROR_CODES, STATES, DERIVED_STATES } from '../../../packages/agent-link/contract/v1.mjs';

const store = (v) => ({ getItem: (k) => (k === V2_FLAG_KEY ? v : null) });

test('플래그: 기본 꺼짐, 환경변수 1 또는 이 기기 값 1일 때만 켜짐, 저장소가 막혀도 꺼짐', () => {
  assert.equal(v2Enabled(undefined, store(null)), false);
  assert.equal(v2Enabled('0', store('0')), false);
  assert.equal(v2Enabled('true', store('true')), false, "정확히 '1'만");
  assert.equal(v2Enabled('1', null), true);
  assert.equal(v2Enabled(undefined, store('1')), true);
  assert.equal(v2Enabled(undefined, { getItem: () => { throw new Error('blocked'); } }), false);
});

test('공간 목록: 개인 공간이 맨 위, 팀 공간은 이름순, 빠짐·만료·삭제된 공간은 뺀다, s: 구독은 owner·admin·member 팀만', () => {
  const now = Date.parse('2026-10-18T00:00:00Z');
  const spaces = [
    { id: 't2', kind: 'team', name: '나중팀' }, { id: 'p', kind: 'personal' }, { id: 't1', kind: 'team', name: '가팀' },
    { id: 't3', kind: 'team', name: '다팀' }, { id: 't4', kind: 'team', name: '라팀' }, { id: 't5', kind: 'team', name: '마팀', deleted_at: '2026-10-01' },
  ];
  const members = [
    { space_id: 't1', role: 'member' }, { space_id: 't2', role: 'guest' }, { space_id: 't3', role: 'admin', removed_at: '2026-10-10' },
    { space_id: 't4', role: 'member', expires_at: '2026-10-17T00:00:00Z' }, { space_id: 't5', role: 'owner' }, { space_id: 'p', role: 'owner' },
  ];
  const list = spaceList({ spaces, members, personalId: 'p', now });
  assert.deepEqual(list.map((s) => [s.id, s.role]), [['p', 'owner'], ['t1', 'member'], ['t2', 'guest']]);
  assert.equal(list[0].personal, true);
  assert.deepEqual(liveSpaceIds(list), ['t1'], '손님 공간·개인 공간은 v2:s:를 구독하지 않는다');
  assert.equal(pickStartSpace(list, 't2'), 't2'); assert.equal(pickStartSpace(list, 'gone'), 'p'); assert.equal(pickStartSpace([], null), null);
});

test('시스템 글: 코드 + 값 → 사전 키(ko·en 둘 다 있음), 모르는 상한·오류·코드도 깨지지 않는다, work.late 표시', () => {
  const nameOf = (k, id) => (k === 'agent' ? `A:${id}` : `U:${id}`);
  for (const l of LIMIT_KINDS) assert.equal(systemLine({ code: 'work.limit', limit: l, agent: 'x' }, nameOf).key, `v2.sys.limit.${l}`);
  assert.equal(systemLine({ code: 'work.limit', limit: 'weird' }).key, 'v2.sys.limit.other');
  for (const e of WORK_ERROR_CODES) assert.equal(systemLine({ code: 'work.error', error: e }).key, `v2.sys.error.${e}`);
  assert.equal(systemLine({ code: 'work.error', error: 'nope' }).key, 'v2.sys.error.internal');
  assert.deepEqual(systemLine({ code: 'work.error', error: 'timeout', agent: 'g', mark: 'work.late' }, nameOf), { key: 'v2.sys.error.timeout', vars: { agent: 'A:g' }, late: true });
  assert.deepEqual(systemLine({ code: 'work.cancelled', by: 'u1', agent: 'g' }, nameOf).vars, { name: 'U:u1', agent: 'A:g' });
  assert.equal(systemLine({ code: 'topic.resolved', by: 'u1' }, nameOf).key, 'v2.sys.resolved');
  assert.equal(systemLine({ code: 'something.new' }).key, 'v2.sys.unknown');
  assert.equal(systemLine({}), null); assert.equal(systemLine(null), null);
  const keys = [...LIMIT_KINDS.map((l) => `v2.sys.limit.${l}`), 'v2.sys.limit.other', ...WORK_ERROR_CODES.map((e) => `v2.sys.error.${e}`), 'v2.sys.cancelled', 'v2.sys.resolved', 'v2.sys.unknown'];
  for (const k of keys) { assert.ok(Array.isArray(DICT[k]) && DICT[k][0] && DICT[k][1], `사전 ${k}`); assert.doesNotMatch(DICT[k][1], /[가-힣]/, `en에 한글 없음 ${k}`); }
});

test('일 카드: 상태 9가지(저장 7 + 계산 2)가 모두 사전 문구로, 결재 단추는 기한 안 + 주인만, 취소는 지시한 사람·주인만', () => {
  const now = Date.parse('2026-10-18T00:00:00Z'); const fut = '2026-10-18T01:00:00Z'; const past = '2026-10-17T23:00:00Z';
  const base = { id: 'w', agent_id: 'a', topic_id: 'tp', owner_user_id: 'own', root_user_id: 'ask', expires_at: fut, lease_until: fut, has_result: false, late: false };
  for (const st of [...STATES, ...DERIVED_STATES]) assert.ok(PHASES[st] && DICT[`v2.work.${PHASES[st]}`], `상태 ${st}`);
  assert.equal(workCard({ work: { ...base, state: 'offered', expires_at: past }, now }).phase, 'expired');
  assert.equal(workCard({ work: { ...base, state: 'running', lease_until: past }, now }).phase, 'unknown', '리스 끝·결과 없음 = 결과 모름');
  assert.equal(workCard({ work: { ...base, state: 'running' }, progress: { stage: 'tool' }, now }).stage, 'tool');
  assert.equal(workCard({ work: { ...base, state: 'failed', error_code: null }, now }).error, 'internal');
  assert.equal(workCard({ work: { ...base, state: 'done', late: true, has_result: true }, now }).late, true);
  const ap = { id: 'ap', state: 'pending', expires_at: fut, action: '메일', risk: 'high', summary: 's' };
  const w = { ...base, state: 'awaiting_approval' };
  assert.equal(workCard({ work: w, approval: ap, uid: 'own', now }).canDecide, true);
  assert.equal(workCard({ work: w, approval: ap, uid: 'ask', now }).canDecide, false, '주인만(서버 msgr2_approval_decide와 같다)');
  const exp = workCard({ work: w, approval: { ...ap, expires_at: past }, uid: 'own', now });
  assert.equal(exp.canDecide, false); assert.equal(exp.approval.state, 'expired', '기한 지난 승인');
  assert.equal(workCard({ work: { ...base, state: 'running' }, uid: 'ask', now }).canCancel, true);
  assert.equal(workCard({ work: { ...base, state: 'running' }, uid: 'other', now }).canCancel, false);
  assert.equal(workCard({ work: { ...base, state: 'done', has_result: true }, uid: 'ask', now }).canCancel, false, '끝난 일은 취소 없음');
  assert.deepEqual(workCard({ work: { ...base, state: 'running', lease_until: past }, effects: [{ key: 'pay', state: 'unknown' }, { key: 'm', state: 'done' }], now }).unknownEffects, ['pay']);
  for (const k of ['v2.work.late', 'v2.work.unknownEffects', 'v2.ap.approve', 'v2.ap.reject', 'v2.work.cancel', 'v2.work.stage.thinking', 'v2.work.stage.tool', 'v2.work.stage.writing']) assert.ok(DICT[k], k);
});

test('일 카드 자리: 시킨 글 바로 아래, 그 글이 목록에 없으면 생긴 시각 자리, 승인 요청 카드 글은 목록에서 뺀다', () => {
  const m = (id, at, extra = {}) => ({ id, created_at: at, kind: 'text', ...extra });
  const msgs = [m(1, '2026-10-18T00:00:01Z'), m(2, '2026-10-18T00:00:05Z'), m(3, '2026-10-18T00:00:09Z', { kind: 'card', meta: { code: 'approval.request' } }), m(4, '2026-10-18T00:00:10Z')];
  // wa는 다음 글(2, 00:05)보다 늦게(00:06) 생겼어도 시킨 글(1) 바로 아래 — 시각 자리가 아니다
  const works = [{ id: 'wa', source_message_id: 1, created_at: '2026-10-18T00:00:06Z' }, { id: 'wb', source_message_id: 999, created_at: '2026-10-18T00:00:07Z' }, { id: 'wc', source_message_id: 1, created_at: '2026-10-18T00:00:03Z' }];
  assert.deepEqual(timeline(msgs, works).map((x) => (x.type === 'msg' ? x.m.id : x.work.id)), [1, 'wc', 'wa', 2, 'wb', 4]);
  // 카드가 있는 일의 오류 시스템 글은 빠지고, 카드가 없는 일의 오류 글은 남는다
  const sys = [m(5, '2026-10-18T00:00:11Z', { kind: 'system', meta: { code: 'work.error', work: 'wa' } }), m(6, '2026-10-18T00:00:12Z', { kind: 'system', meta: { code: 'work.error', work: 'gone' } })];
  assert.deepEqual(timeline([...msgs, ...sys], works).filter((x) => x.type === 'msg').map((x) => x.m.id), [1, 2, 4, 6]);
});

test('@멘션: 방 에이전트의 이름·slug만, 단어 경계, 중복 0, 20개까지', () => {
  const agents = [{ id: 'a1', display_name: '에이', slug: 'a' }, { id: 'a2', display_name: 'Bee', slug: 'bee' }, { id: 'a3', display_name: 'c.d', slug: 'cd' }];
  assert.deepEqual(mentionsOf('@에이 그리고 @bee, 부탁', agents), ['a1', 'a2']);
  assert.deepEqual(mentionsOf('메일 foo@bee.com', agents), [], '메일 주소는 멘션이 아니다');
  assert.deepEqual(mentionsOf('@c.d 확인', agents), ['a3'], '정규식 특수문자 이름');
  assert.deepEqual(mentionsOf('@에이 @에이', agents), ['a1']);
  assert.equal(mentionsOf(Array.from({ length: 30 }, (_, i) => `@n${i}`).join(' '), Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, slug: `n${i}` }))).length, 20);
});

test('v2 부품 사전 전수: WorkCard·useWorkCards·source·composer·runtime의 정적 t(키)는 모두 ko·en 쌍, 주석 밖 한글 문자열 0, window.confirm·prompt 0', async () => {
  const { readFileSync } = await import('node:fs');
  const src = ['WorkCard.jsx', 'useWorkCards.jsx', 'source.mjs', 'composer.mjs', 'runtime.mjs', 'DevicesCard.jsx', 'devices.mjs'].map((f) => readFileSync(new URL(`../src/v2/${f}`, import.meta.url), 'utf8')).join('\n'); // U6c-1b: 기존 셸에 끼우는 v2 부품 전부
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const keys = [...code.matchAll(/\bt\(\s*'([a-z0-9._]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, `키 ${keys.length}개`);
  const missing = keys.filter((k) => !(Array.isArray(DICT[k]) && DICT[k][0] && DICT[k][1]));
  assert.deepEqual([...new Set(missing)], []);
  // 템플릿 키(v2.work.${phase} 등)는 위 상태·단계 시험이 사전을 확인한다
  assert.doesNotMatch(code, /[가-힣]/, '사전 밖 한글');
  assert.doesNotMatch(code, /\bwindow\.(confirm|prompt)\(/);
});

test('결과 모름 보호(#1085 검수): 진행 신호를 받은 뒤 리스 한 번은 살아 있다, 그래도 stalled면 한 번 다시 읽는 동안은 진행 중으로, 다시 읽은 같은 행은 결과 모름', async () => {
  const { stalledGuard, rowKey, LEASE_MS, workCard: card } = await import('../src/v2/work-card.mjs');
  const now = Date.parse('2026-10-18T10:00:00Z');
  const w = { id: 'w1', state: 'running', has_result: false, lease_until: new Date(now - 60_000).toISOString(), updated_at: '2026-10-18T09:40:00Z', expires_at: new Date(now + 1e6).toISOString(), owner_user_id: 'o', root_user_id: 'u' };
  // ① 진행 신호가 리스 안이면 살아 있다(요청 없음)
  const alive = stalledGuard({ work: w, aliveAt: now - LEASE_MS + 30_000, now });
  assert.equal(alive.recheck, false); assert.equal(card({ work: alive.view, now }).phase, 'working');
  // 진행 신호가 리스보다 오래됐으면 stalled 후보
  const old = stalledGuard({ work: w, aliveAt: now - LEASE_MS - 1, now });
  assert.equal(old.recheck, true, '다시 읽기 요청'); assert.equal(card({ work: old.view, now }).phase, 'working', '다시 읽는 동안 결과 모름을 그리지 않는다');
  // ② 신호가 없어도 처음 stalled는 다시 읽기부터
  const first = stalledGuard({ work: w, now });
  assert.equal(first.recheck, true); assert.equal(first.key, rowKey(w));
  // 다시 읽은 같은 행(리스·갱신 시각 그대로)은 결과 모름
  const after = stalledGuard({ work: w, checked: new Set([rowKey(w)]), now });
  assert.equal(after.recheck, false); assert.equal(card({ work: after.view, now }).phase, 'unknown');
  // 다시 읽었더니 리스가 늘어 있었다(다른 행 표지) → 진행 중
  const renewed = { ...w, lease_until: new Date(now + 300_000).toISOString(), updated_at: '2026-10-18T09:59:00Z' };
  const r = stalledGuard({ work: renewed, checked: new Set([rowKey(w)]), now });
  assert.equal(r.recheck, false); assert.equal(card({ work: r.view, now }).phase, 'working');
  // 결과가 있는 일·끝난 일은 건드리지 않는다
  assert.equal(stalledGuard({ work: { ...w, state: 'done' }, now }).recheck, false);
  assert.equal(stalledGuard({ work: { ...w, has_result: true }, now }).recheck, false);
});

test('④ 기기 목록·상태 안내(U6c-2a): 이 기기 먼저·사용 중 먼저, 모르는 값은 안전한 쪽, 중단·업데이트는 안내 줄, 폐기·다시 로그인은 로그인 화면 이유', async () => {
  const { deviceRows, v2StateBar, v2SignOutNotice } = await import('../src/v2/devices.mjs');
  const rows = deviceRows([
    { id: 'a', kind: 'runner', app: 'desktop', app_version: '0.9.1', registered_at: '2026-10-17T01:00:00Z', state: 'active', is_current: false },
    { id: 'b', kind: 'app', app: 'messenger', app_version: '0.2.0', registered_at: '2026-10-10T01:00:00Z', state: 'active', is_current: true },
    { id: 'c', kind: 'app', app: 'messenger', registered_at: '2026-10-18T01:00:00Z', state: 'revoked', is_current: false },
    { id: 'd', kind: 'robot', app: 'x', state: 'weird' },
  ], { lang: 'en' });
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a', 'c', 'd'], '이 기기 → 사용 중 → 최근순');
  assert.equal(rows[0].current, true); assert.equal(rows[1].active, true); assert.equal(rows[2].active, false);
  assert.deepEqual([rows[3].kind, rows[3].app, rows[3].state, rows[3].active], ['other', 'other', 'revoked', false], '모르는 값');
  for (const r of rows) for (const k of [`v2.dev.kind.${r.kind}`, `v2.dev.app.${r.app}`, `v2.dev.state.${r.state}`]) assert.ok(DICT[k]?.[0] && DICT[k]?.[1], k);
  assert.equal(v2StateBar({ state: 'paused' }), 'v2.state.paused'); assert.equal(v2StateBar({ state: 'update_required' }), 'v2.state.update');
  assert.equal(v2StateBar({ state: 'ready' }), null); assert.equal(v2StateBar({ state: 'signed_out' }), null); assert.equal(v2StateBar(null), null);
  assert.equal(v2SignOutNotice({ state: 'signed_out', reason: 'device_revoked' }), 'v2.state.signedOut');
  assert.equal(v2SignOutNotice({ state: 'signed_out', reason: 'login_required' }), 'v2.state.loginRequired');
  assert.equal(v2SignOutNotice({ state: 'paused' }), null);
  for (const k of ['v2.state.paused', 'v2.state.update', 'v2.state.signedOut', 'v2.state.loginRequired']) assert.doesNotMatch(DICT[k][1], /[가-힣]/, k);
});
