// 늦은 첨부 되찾기 배선(C-a, 2026-10-08) — App.jsx Channel의 실제 효과·함수 본문을 꺼내 가짜 DB로 돌린다(open-room-sync·realtime-wiring과 같은 방식).
// 실측(로컬 스택 + 메신저 개발 서버): 답이 빈 첨부로 읽힌 뒤 실시간 연결이 끊긴 사이 첨부가 등록되면 'attach' 방송을 받지 못하고,
// 다시 붙은 뒤(rt_up·u: 다시 붙음)·끊긴 동안의 10초 보정 조회 어느 쪽도 그 글의 첨부를 다시 읽지 않아 방을 다시 열 때까지 파일 카드가 없었다(개인 방·조직 공개·조직 비공개 셋 다).
// 고친 길: 방송을 놓쳤을 수 있는 때(rt_up·u: 다시 붙음·끊긴 동안의 보정 조회)에만 1시간 안 빈 첨부 글의 첨부를 한 번 읽는다. 글 방송마다는 읽지 않는다(요청 수 그대로).
// late-attach.mjs가 없는 옛 코드(origin/main)에서도 돌도록 늦은 첨부 함수는 있으면 쓴다 — 없으면 시나리오가 실패한다(고치기 전 결함 그대로).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCatchUp } from '../src/refresh-messages.mjs';

const late = await import('../src/late-attach.mjs').catch(() => ({}));
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false');
const between = (from, to) => { const s = app.indexOf(from); assert.ok(s >= 0, `찾지 못함: ${from}`); const e = app.indexOf(to, s); assert.ok(e > s, `끝을 찾지 못함: ${to}`); return app.slice(s, e); };
const maybe = (from, to) => (app.includes(from) ? between(from, to).slice(from.length) : null);
const build = (src, scope) => new Function(...Object.keys(scope), `return (${src});`)(...Object.values(scope));
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

const eventEffectSrc = between('useEffect(() => {\n    if (!event) return;', '}, [event]);').slice('useEffect('.length) + '}';
const hydrateSrc = between('const hydrate = useCallback(async (ids) => {', ', []);').slice('const hydrate = useCallback('.length);
const uEffectSrc = between('useEffect(() => { if (uRejoinSeen.current === uRejoin) return;', ', [uRejoin]);').slice('useEffect('.length);
const downEffectSrc = between('useEffect(() => { if (!onScreen || !rtDown) return undefined;', ', [onScreen, rtDown,').slice('useEffect('.length);
const lateAttsSrc = maybe('const lateAtts = useMemo(() => ', ', []);');
const recoverSrc = maybe('const recover = useCallback(', ', [catchUp, lateAtts]);');

const NOW = Date.now();
const reply = (id, minsAgo = 4) => ({ id, author_kind: 'crew', author_user_id: null, crew_id: 'pepper', kind: 'text', body: 'download-test.md', mentions: [], reply_to: 3795, created_at: new Date(NOW - minsAgo * 60_000).toISOString(), deleted_at: null });
const file = (id) => ({ id: `att-${id}`, message_id: id, storage_path: `p/ch/${id}/0-download-test.md`, name: 'download-test.md', mime: 'text/markdown', bytes: 37 });

/** 열린 방 하나 — live(화면 상태)·가짜 DB(서버 첨부 행)·호출 기록. 늦은 첨부·되찾기는 App.jsx 본문 그대로(있으면). */
function room({ msgs, atts, server = [] }) {
  const live = { current: { msgs, atts } };
  const calls = { att: [], reacts: 0, catchUp: 0, approvals: 0, reloadAtts: [], rtDown: [] };
  const from = (table) => { const st = { table, ids: null }; const b = { st, select: () => b, in: (k, v) => { st.ids = v; return b; }, eq: (k, v) => { st.ids = [v]; return b; } }; return b; };
  const q = async (b) => {
    if (b.st.table === 'msgr_attachments') { calls.att.push(b.st.ids); return server.filter((r) => b.st.ids.includes(r.message_id)); }
    if (b.st.table === 'msgr_reactions') { calls.reacts++; return []; }
    throw new Error(`예상 밖 조회 ${b.st.table}`);
  };
  const supabase = { from };
  const setAtts = (f) => { live.current = { ...live.current, atts: typeof f === 'function' ? f(live.current.atts) : f }; };
  const catchUp = async () => { calls.catchUp++; };
  const loadApprovals = async () => { calls.approvals++; };
  const lateAtts = lateAttsSrc ? build(lateAttsSrc, { createCatchUp, live, lateAttachCandidates: late.lateAttachCandidates, q, supabase, setAtts, mergeAttachments: late.mergeAttachments }) : null;
  const recover = recoverSrc ? build(recoverSrc, { catchUp, lateAtts }) : undefined;
  const scope = { chId: 'ch', rtSeen: { current: 0 }, live, catchUp, loadApprovals, setRtDown: (v) => calls.rtDown.push(v), recover,
    reloadReacts: async () => {}, reloadMsg: async () => {}, reloadAtts: async (id) => { calls.reloadAtts.push(id); } };
  const fire = (event) => build(eventEffectSrc, { ...scope, event })();
  return { live, calls, fire, scope, server, q, supabase, setAtts };
}

test('운영 사례 꼴 — 답(3798)이 빈 첨부로 읽힌 뒤 끊긴 사이 첨부가 등록됐다: 다시 붙으면(rt_up) 방을 다시 열지 않아도 카드가 붙는다', async () => {
  const r = room({ msgs: [reply(3798)], atts: { 3798: [] }, server: [file(3798)] });
  r.fire({ kind: 'rt_up', at: NOW }); await settle();
  assert.deepEqual(r.live.current.atts[3798]?.map((a) => a.name), ['download-test.md'], '다시 붙은 뒤에도 카드가 없으면 방을 다시 열어야 보인다(고치기 전)');
  assert.deepEqual(r.calls.att, [[3798]], '첨부 조회 1건 — 빈 첨부 글만');
  assert.deepEqual([r.calls.catchUp, r.calls.approvals, r.calls.rtDown], [1, 1, [false]], '새 글 따라잡기·결재·보정 조회 끄기는 그대로');
});

test('다시 붙어도 받을 게 없으면 첨부 조회 0건 — 첨부가 이미 보이는 글·1시간 지난 글·시스템 글뿐', async () => {
  const sys = { ...reply(12, 1), kind: 'system' };
  const r = room({ msgs: [reply(10, 2), reply(11, 90), sys], atts: { 10: [file(10)], 11: [], 12: [] }, server: [file(10), file(11)] });
  r.fire({ kind: 'rt_up', at: NOW }); await settle();
  assert.deepEqual(r.calls.att, []);
  assert.deepEqual(r.live.current.atts[11], [], '1시간 지난 빈 글에는 더 붙지 않는다(봇 첨부 기한) — 읽지 않는다');
});

test('글 방송·반응·수정 방송에는 늦은 첨부를 읽지 않는다(방송 1건마다 요청이 늘지 않게) — attach 방송은 종전처럼 그 글만 다시 읽는다', async () => {
  const r = room({ msgs: [reply(3798)], atts: { 3798: [] }, server: [file(3798)] });
  r.fire({ kind: 'message', channel_id: 'ch', id: 3799, at: NOW });
  r.fire({ kind: 'reaction', channel_id: 'ch', message_id: 3798, at: NOW });
  r.fire({ kind: 'edit', channel_id: 'ch', message_id: 3798, at: NOW });
  await settle();
  assert.deepEqual([r.calls.att, r.calls.catchUp], [[], 1], '새 글이면 따라잡기 1, 첨부 조회 0');
  r.fire({ kind: 'attach', channel_id: 'ch', message_id: 3798, id: 3798, at: NOW }); await settle();
  assert.deepEqual([r.calls.reloadAtts, r.calls.att], [[3798], []], 'attach 방송 → reloadAtts(그 글) 하나');
  r.fire({ kind: 'attach', channel_id: 'other', message_id: 9, id: 9, at: NOW }); await settle();
  assert.deepEqual(r.calls.reloadAtts, [3798], '다른 방의 attach는 무시');
});

test('u:가 다시 붙을 때(조직 비공개 방 — 글·첨부 방송이 u:로만 온다) 늦은 첨부도 되찾는다, 공개 채널·개인 방은 rt_up이 맡는다(종전 규칙)', async () => {
  for (const o of [{ kind: 'dm' }, { kind: 'private' }]) {
    const r = room({ msgs: [reply(3798)], atts: { 3798: [] }, server: [file(3798)] });
    const seen = { current: 0 };
    const run = (uRejoin) => build(uEffectSrc, { uRejoin, uRejoinSeen: seen, isPersonal: false, channel: { id: 'ch', kind: o.kind }, catchUp: r.scope.catchUp, loadApprovals: r.scope.loadApprovals, recover: r.scope.recover })();
    run(0); await settle();
    assert.deepEqual(r.calls.att, [], `${o.kind}: 방을 연 순간(마운트)은 읽지 않는다`);
    run(1); await settle();
    assert.equal(r.live.current.atts[3798]?.length, 1, o.kind);
    assert.deepEqual([r.calls.att.length, r.calls.catchUp], [1, 1], o.kind);
  }
  for (const o of [{ kind: 'public', isPersonal: false }, { kind: 'dm', isPersonal: true }]) {
    const r = room({ msgs: [reply(3798)], atts: { 3798: [] }, server: [file(3798)] });
    const run = (uRejoin) => build(uEffectSrc, { uRejoin, uRejoinSeen: { current: 0 }, isPersonal: o.isPersonal, channel: { id: 'ch', kind: o.kind }, catchUp: r.scope.catchUp, loadApprovals: r.scope.loadApprovals, recover: r.scope.recover })();
    run(1); await settle();
    assert.deepEqual([r.calls.att.length, r.calls.catchUp], [0, 0], JSON.stringify(o));
  }
});

test('실시간이 계속 끊겨 있는 동안(웹소켓을 막는 망 등) 10초 보정 조회가 늦은 첨부도 읽는다 — 방송이 없으니 다음 보정에서 카드가 붙는다', async () => {
  const r = room({ msgs: [reply(3798)], atts: { 3798: [] }, server: [file(3798)] });
  let tick = null; let cleared = false;
  const stop = build(downEffectSrc, { onScreen: true, rtDown: true, setInterval: (fn, ms) => { assert.equal(ms, 10_000); tick = fn; return 1; }, clearInterval: () => { cleared = true; }, recover: r.scope.recover, catchUp: r.scope.catchUp, loadApprovals: r.scope.loadApprovals })();
  tick(); await settle();
  assert.equal(r.live.current.atts[3798]?.length, 1);
  assert.deepEqual([r.calls.catchUp, r.calls.approvals, r.calls.att.length], [1, 1, 1]);
  stop(); assert.equal(cleared, true);
  const up = build(downEffectSrc, { onScreen: true, rtDown: false, setInterval: () => assert.fail('끊기지 않았으면 보정 조회 없음'), clearInterval: () => {}, recover: r.scope.recover, catchUp: r.scope.catchUp, loadApprovals: r.scope.loadApprovals })();
  assert.equal(up, undefined);
});

test('인접 핀 — 첫 로드·새 글의 첨부 읽기(hydrate)는 이미 보이는 첨부를 빈 결과로 덮지 않고, 못 읽은 글은 빈 묶음으로 표시한다', async () => {
  const r = room({ msgs: [], atts: { 5: [file(5)] }, server: [file(7)] });
  const hydrate = build(hydrateSrc, { q: r.q, supabase: r.supabase, setAtts: r.setAtts, setReacts: () => {}, mergeAttachments: late.mergeAttachments });
  await hydrate([5, 6, 7]);
  assert.deepEqual(r.live.current.atts[5].map((a) => a.id), ['att-5'], '늦게 도착한 빈 결과가 attach 방송으로 읽은 첨부를 지우지 않는다');
  assert.deepEqual(r.live.current.atts[6], []);
  assert.deepEqual(r.live.current.atts[7].map((a) => a.id), ['att-7']);
  assert.equal(r.calls.att.length, 1);
});
