// F2·F2+(2026-10-05 분리 검증) — 크루 대화 폴링 반영 규칙.
// F2: 새로고침·다른 화면에서 돌아온 뒤 턴이 실패·중단되면 실패 표시와 재전송 버튼이 안 떴다(길이가 같으면 무시하던 병합).
// F2+: 2.5초 진행 폴이 바뀐 본문을 버리고 mtime만 옮겨, 3초 폴이 unchanged를 받아 성공한 답이 화면에 안 붙었다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePolledThread, pollStep } from '../app/c/[ws]/crew/[slug]/thread-poll.mjs';

const u = (text, extra = {}) => ({ who: 'user', text, mid: `m-${text}`, ts: 1, ...extra });
const c = (text) => ({ who: 'crew', text, ts: 2 });

test('F2: 서버가 저장된 지시 줄에 실패를 붙이면(길이 그대로) 화면에 실패 표시가 반영된다', () => {
  const cur = [u('안녕'), c('네'), u('보고서 써줘')]; // 새로고침 뒤 — 지시는 beginTurn이 먼저 저장해 화면에 있다
  const server = [u('안녕'), c('네'), u('보고서 써줘', { failed: 'AI 러너가 연결되지 않았습니다', failedCode: 'no_runner' })];
  const next = mergePolledThread(cur, server);
  assert.equal(next[2].failed, 'AI 러너가 연결되지 않았습니다', '실패 사유가 화면에 붙는다(재전송 버튼의 근거)');
  assert.equal(next[2].failedCode, 'no_runner');
});

test('F2: 뜻이 같으면 화면 참조를 그대로 둔다 — 낙관 사본(로컬 mid·ts)을 서버 사본으로 바꿔 끼우지 않는다', () => {
  const cur = [u('안녕', { mid: 's-local', ts: 99 }), c('네')];
  const server = [u('안녕', { mid: 'srv-1', ts: 5 }), c('네')];
  assert.equal(mergePolledThread(cur, server), cur);
  assert.equal(mergePolledThread(cur, [u('안녕')]), cur, '서버가 더 짧으면(옛 응답) 화면을 줄이지 않는다');
});

test('서버 미보존 실패 사본은 이어 붙이고, 서버가 보존한 실패는 복제하지 않는다', () => {
  const local = u('보낸 글', { failed: 'x', unsaved: true, mid: 's-9' });
  const cur = [u('안녕'), c('네'), local];
  assert.equal(mergePolledThread(cur, [u('안녕'), c('네')]), cur, '변화 없음 — 그대로');
  const grown = mergePolledThread(cur, [u('안녕'), c('네'), u('다른 창구'), c('답')]);
  assert.deepEqual(grown.map((m) => m.text), ['안녕', '네', '다른 창구', '답', '보낸 글']);
});

test('F2+: 진행 폴과 준실시간 폴은 같은 반영 경로 — 본문을 반영할 때만 mtime을 옮긴다', () => {
  const body = { mtime: 200, status: null, messages: [u('지시'), c('완료했습니다')] };
  const s = pollStep(body);
  assert.equal(s.apply, true);
  assert.equal(s.mtime, 200);
  assert.deepEqual(s.messages.map((m) => m.text), ['지시', '완료했습니다']);
  const busy = pollStep(body, { busy: true });
  assert.equal(busy.apply, false, '내 턴이 도는 중에는 낙관 사본을 덮지 않는다');
  assert.equal(busy.refetch, true, '본문을 버리면 다시 받기 표지를 세운다 — 턴이 끝난 뒤 첫 유휴 폴이 전체를 받아 놓친 변경을 합친다');
  const same = pollStep({ unchanged: true, mtime: 200, status: { stage: 'thinking' } });
  assert.equal(same.apply, false);
  assert.deepEqual(same.status, { stage: 'thinking' });
});

// UL3(2026-10-05 분리 검수): applyPoll에 방(slug) 확인이 없어 크루를 바꾸기 직전에 나간 폴 응답이 새 방에 섞일 수 있었다(F2+로 조건이 넓어짐).
// 그리고 위 테스트는 순수 함수만 봐서, 진행 폴을 옛 방식(본문을 버리고 mtime만 옮김)으로 되돌려도 통과했다(L10).
// 폴 두 줄기를 시작하는 함수(startThreadPolls)를 행동으로 잠근다: ① 두 폴이 같은 반영기를 지난다 ② 멈춘 뒤(방 전환·언마운트)에 도착한 응답은 버린다.
import { makePollApplier, startThreadPolls } from '../app/c/[ws]/crew/[slug]/thread-poll.mjs';

function fakeTimers() {
  const timers = []; let next = 1;
  return {
    setInterval: (fn, ms) => { const id = next++; timers.push({ id, fn, ms, on: true }); return id; },
    clearInterval: (id) => { const t = timers.find((x) => x.id === id); if (t) t.on = false; },
    tick: (ms) => timers.filter((t) => t.ms === ms && t.on).forEach((t) => t.fn()),
    live: () => timers.filter((t) => t.on).length,
  };
}
function harness({ busy = false, working = false, mtime = 100, refetch = false } = {}) {
  const st = { busy, working, mtime, refetch, status: null, thread: [u('지시')], requests: [], resolvers: [] };
  const timers = fakeTimers();
  const apply = makePollApplier({
    isBusy: () => st.busy, setStatus: (s) => { st.status = s; }, setMtime: (m) => { st.mtime = m; }, setRefetch: (v) => { st.refetch = v; },
    mergeThread: (msgs) => { st.thread = mergePolledThread(st.thread, msgs); },
  });
  const stop = startThreadPolls({
    fetchThread: (m) => new Promise((res) => { st.requests.push(m); st.resolvers.push(res); }),
    apply, isBusy: () => st.busy, isWorking: () => st.working, getMtime: () => st.mtime, shouldRefetch: () => st.refetch, timers,
  });
  return { st, timers, stop };
}
const flush = () => new Promise((r) => setImmediate(r));

test('UL3: 두 폴 모두 같은 반영기를 지난다 — 진행 폴(2.5초)이 받은 새 답도 화면에 붙는다(F2+ 연결)', async () => {
  const h = harness({ working: true }); // 내 턴이 아니라 결재 후속·루틴 턴이 도는 중 — 진행 폴만 돈다
  h.timers.tick(2500);
  assert.deepEqual(h.st.requests, [100], '진행 폴은 마지막 mtime으로 묻는다');
  h.st.resolvers[0]({ mtime: 200, status: { stage: 'thinking' }, messages: [u('지시'), c('완료했습니다')] });
  await flush();
  assert.deepEqual(h.st.thread.map((m) => m.text), ['지시', '완료했습니다'], '바뀐 본문을 버리지 않는다');
  assert.equal(h.st.mtime, 200);
  assert.deepEqual(h.st.status, { stage: 'thinking' });
  const idle = harness();
  idle.timers.tick(3000);
  idle.st.resolvers[0]({ mtime: 300, messages: [u('지시'), c('3초 폴이 받은 답')] });
  await flush();
  assert.deepEqual(idle.st.thread.map((m) => m.text), ['지시', '3초 폴이 받은 답']);
});

test('UL3: 폴 조건 — 내 턴이면 3초 폴은 쉬고(낙관 사본 보호), 안 도는 중이면 2.5초 폴은 쉰다. 다시 받기 표지는 mtime 0', async () => {
  const h = harness({ busy: true, working: true });
  h.timers.tick(3000);
  assert.deepEqual(h.st.requests, [], '내 턴 중에는 3초 폴을 묻지 않는다');
  h.timers.tick(2500);
  assert.deepEqual(h.st.requests, [100]);
  h.st.resolvers[0]({ mtime: 150, messages: [u('지시'), c('중간')] });
  await flush();
  assert.equal(h.st.refetch, true, '내 턴 중 버린 본문 — 다음 유휴 폴이 전체를 다시 받는다');
  assert.deepEqual(h.st.thread.map((m) => m.text), ['지시'], '낙관 사본은 덮이지 않는다');
  h.st.busy = false; h.st.working = false;
  h.timers.tick(2500);
  assert.equal(h.st.requests.length, 1, '아무것도 안 도는 중이면 진행 폴은 묻지 않는다');
  h.timers.tick(3000);
  assert.deepEqual(h.st.requests, [100, 0], '유휴 폴은 refetch 표지가 있으면 mtime 0으로 전체를 받는다');
});

test('UL3: 멈춘 뒤(크루 전환·화면 이탈)에 도착한 이전 방의 응답은 새 방에 섞이지 않는다', async () => {
  const h = harness({ working: true });
  h.timers.tick(2500); h.timers.tick(3000);
  assert.equal(h.st.requests.length, 2, '두 줄기 모두 요청이 나가 있다');
  h.stop(); // 크루를 바꾸면 effect 정리가 부른다
  assert.equal(h.timers.live(), 0, '타이머도 모두 멈춘다');
  h.st.resolvers[0]({ mtime: 999, status: { stage: 'old-room' }, messages: [u('지시'), c('이전 방의 답')] });
  h.st.resolvers[1]({ mtime: 999, status: { stage: 'old-room' }, messages: [u('지시'), c('이전 방의 답')] });
  await flush();
  assert.deepEqual(h.st.thread.map((m) => m.text), ['지시'], '이전 방 응답이 반영되지 않는다');
  assert.equal(h.st.mtime, 100); assert.equal(h.st.status, null);
});
