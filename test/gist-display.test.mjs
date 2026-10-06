// UX-A08(2026-10-05): 아침 조회·활동·작업 독의 지시 요약 줄에 메신저 턴의 내부 머리말이 그대로 보였다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gistView, gistLabel } from '../app/lib/gist-display.mjs';
import { msgrHead } from '../src/inbound-marks.mjs';

const t = (k, v) => (k === 'activity.msgrGist' ? `팀 메신저 #${v.channel}에서 받은 지시` : k);

test('엔진이 만든 60자 gist(머리말뿐)는 채널 이름만 남긴 사람 문장으로 보인다', () => {
  const userMsg = `${msgrHead('test', 'ko')}주인 김효율의 메시지. 아래는 크루 주인의 지시다: 요청 범위 안에서만 답하고, 회사 워크스페이스 밖 파일]\n\n보고서 써줘`;
  const gist = userMsg.slice(0, 60); // chat.mjs 1544·1953과 같은 자르기
  assert.equal(gistView(gist).channel, 'test');
  const label = gistLabel(gist, t);
  assert.equal(label, '팀 메신저 #test에서 받은 지시');
  assert.doesNotMatch(label, /크루 주인의 지시다|요청 범위/, '크루에게만 보일 지시문이 화면에 새지 않는다');
  assert.equal(gistLabel(`${msgrHead('ops', 'en')}message from owner Kim.]\n보고`, t), '#ops · 보고', '머리말 뒤 본문이 남으면 본문을 보인다(영어 머리말 포함)');
});

test('메신저 머리말이 아닌 gist는 그대로', () => {
  assert.equal(gistLabel('보고서 써줘', t), '보고서 써줘');
  assert.equal(gistLabel('[메모] 이건 사용자 글', t), '[메모] 이건 사용자 글');
  assert.equal(gistLabel(undefined, t), '');
});
