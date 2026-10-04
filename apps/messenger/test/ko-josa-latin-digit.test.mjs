// 조사 고르기 — 끝 글자가 영문·숫자일 때의 받침. 종전엔 한글이 아니면 전부 "받침 없음"이라
// 공간 전환 안내가 "Fixture Organization로 돌아가기"로 나왔고, "Team 3로"·"1를"도 같았다(2026-10-04).
// 규칙: 숫자는 한국어로 읽은 소리(영·일·삼·육·칠·팔은 받침, 일·칠·팔은 ㄹ), 영문은 n·m·ng(ㄴ·ㅁ·ㅇ)와 l(ㄹ)만 받침.
// 그 밖의 영문·기호는 종전대로 받침 없음 — 받침이 확실한 끝만 바꿔 지금보다 나빠지는 문구가 없게 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { koJosa } from '../src/ko-josa.mjs';
import { t } from '../src/i18n.js';

test('영문 끝 n·m·ng는 받침(ㄴ·ㅁ·ㅇ) — 공간 전환 안내 "Fixture Organization으로 돌아가기"', () => {
  assert.equal(koJosa('Fixture Organization(으)로 돌아가기'), 'Fixture Organization으로 돌아가기');
  assert.equal(koJosa('Team이(가)'), 'Team이');
  assert.equal(koJosa('Kang을(를)'), 'Kang을');
  assert.equal(koJosa('DM은(는)'), 'DM은', '대문자도 같다');
});

test('영문 끝 l은 ㄹ 받침 — 이·을·은이 붙고 (으)로는 "로"', () => {
  assert.equal(koJosa('Bill이(가)'), 'Bill이');
  assert.equal(koJosa('Bill을(를)'), 'Bill을');
  assert.equal(koJosa('Bill은(는)'), 'Bill은');
  assert.equal(koJosa('Bill(으)로'), 'Bill로');
});

test('그 밖의 영문 끝은 종전대로 받침 없음', () => {
  assert.equal(koJosa('Argo이(가)'), 'Argo가');
  assert.equal(koJosa('Lean-AX(으)로'), 'Lean-AX로');
  assert.equal(koJosa('Claude을(를)'), 'Claude를');
  assert.equal(koJosa('Greg이(가)'), 'Greg가', 'g 앞이 n이 아니면 ng가 아니다');
  assert.equal(koJosa('g이(가)'), 'g가', '문장 첫 글자 g — 앞 글자가 없다');
});

test('숫자 끝은 한국어로 읽은 소리의 받침 — 영·일·삼·육·칠·팔은 받침, 일·칠·팔은 ㄹ', () => {
  const digits = [...'0123456789'];
  assert.deepEqual(digits.map((d) => koJosa(`${d}(으)로`)), ['0으로', '1로', '2로', '3으로', '4로', '5로', '6으로', '7로', '8로', '9로']);
  assert.deepEqual(digits.map((d) => koJosa(`${d}을(를)`)), ['0을', '1을', '2를', '3을', '4를', '5를', '6을', '7을', '8을', '9를']);
  assert.equal(koJosa('Team 3(으)로'), 'Team 3으로');
  assert.equal(koJosa('10(으)로'), '10으로', '끝자리 0은 십·백·천·만으로 읽어도 ㄹ이 아닌 받침');
});

test('닫는 따옴표 건너뛰기는 영문·숫자 끝에도 그대로', () => {
  assert.equal(koJosa("'Kang'이(가) 왔다"), "'Kang'이 왔다");
  assert.equal(koJosa("'Bill'을(를) 넣어"), "'Bill'을 넣어");
  assert.equal(koJosa('“Room 2”을(를)'), '“Room 2”를');
});

test('사전 문장 — 에이전트 꺼짐 안내·크루 넣기 승인 안내에 영어 이름', () => {
  assert.equal(koJosa(t('crew.dm.away', 'ko', { name: 'Kevin' })), 'Kevin이 꺼져 있어 답하지 않습니다. 켜지면 보낸 글에 답합니다.');
  assert.equal(koJosa(t('personal.crewReq.named', 'ko', { name: 'Alice', crew: 'Hermes 3' })), 'Alice님이 자기 에이전트 Hermes 3을 이 방에 넣으려고 합니다. 허락하면 Hermes 3이 이 방의 대화를 읽고 답할 수 있습니다.');
});
