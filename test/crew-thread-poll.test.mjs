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
