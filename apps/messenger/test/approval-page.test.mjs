// 폰 결재 페이지(유건 2026-10-02) — 등급 문구 매핑·한두 줄 요약·페이지에 보일 카드 행동 테스트.
// 서버 등급 값은 msgr_crew_approvals.risk in ('low','high') 두 가지뿐이다(20260903120000_msgr.sql). 값은 바꾸지 않고 표시만:
//   high → '꼭 확인', low 중 회사 안 행동(src/approval-risk.mjs LOW_KINDS: profile·hire·loop) → '가벼운 일', 나머지 low → '보통'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalGrade, APPROVAL_GRADES, approvalSummaryKey, approvalPageItems } from '../src/approval-display.js';
import { t } from '../src/i18n.js';
import { koJosa } from '../src/ko-josa.mjs';

test('등급 매핑 — high는 꼭 확인, 회사 안 행동은 가벼운 일, 그 밖의 low는 보통', () => {
  assert.equal(approvalGrade({ risk: 'high', kind: 'action' }), 'must');
  assert.equal(approvalGrade({ risk: 'high', kind: 'profile' }), 'must', '서버가 high로 잠갔으면 종류와 무관하게 꼭 확인(하향 없음)');
  assert.equal(approvalGrade({ risk: 'low', kind: 'profile' }), 'light');
  assert.equal(approvalGrade({ risk: 'low', kind: 'hire' }), 'light');
  assert.equal(approvalGrade({ risk: 'low', kind: 'loop' }), 'light');
  assert.equal(approvalGrade({ risk: 'low', kind: 'action' }), 'normal');
  assert.equal(approvalGrade({ risk: 'low' }), 'normal');
  assert.equal(approvalGrade({}), 'normal', '등급이 없으면(옛 행) 보통 — 꼭 확인을 낮추는 쪽으로 틀리지 않게 high만 must');
});

test('에이전트 넣기 요청은 결재 표의 등급이 없다 — 등급 칩을 그리지 않는다', () => {
  assert.equal(approvalGrade({ kind: 'join' }), null);
});

test('등급 문구 — 꼭 확인 · 보통 · 가벼운 일, ko/en 모두 있다. 위험·고위험이라는 말은 쓰지 않는다', () => {
  assert.deepEqual(APPROVAL_GRADES, ['must', 'normal', 'light']);
  assert.deepEqual(APPROVAL_GRADES.map((k) => t(`ap.level.${k}`, 'ko')), ['꼭 확인', '보통', '가벼운 일']);
  for (const k of APPROVAL_GRADES) assert.ok(t(`ap.level.${k}`, 'en') && t(`ap.level.${k}`, 'en') !== `ap.level.${k}`);
  for (const key of ['ap.approverNote', 'ap.adminNote', 'set.policy.approval', 'set.policy.approvers.desc', 'crew.tier.personal.note']) {
    assert.doesNotMatch(t(key, 'ko'), /위험/, key);
    assert.doesNotMatch(t(key, 'en'), /[Hh]igh[- ]risk/, key);
  }
});

const say = (a, lang = 'ko') => { const [k, v] = approvalSummaryKey(a); const s = t(k, lang, v); return lang === 'ko' ? koJosa(s) : s; };

test('요약 — 목적과 할 일이 있으면 "목적을 위해 할 일"', () => {
  const a = { action: 'sendGmail(to=subs)', payload: { plain: { purpose: '이번 달 뉴스레터 발송', task: '구독자 1200명에게 메일 발송', need: 'Gmail 권한' } } };
  assert.equal(say(a), '이번 달 뉴스레터 발송을 위해 구독자 1200명에게 메일 발송');
  assert.match(say(a, 'en'), /구독자 1200명에게 메일 발송/);
});

test('요약 — 목적만 있으면 할 일 자리에 원래 행동(action)', () => {
  assert.equal(say({ action: '보고서 업로드', payload: { plain: { purpose: '분기 보고' } } }), '분기 보고를 위해 보고서 업로드');
});

test('요약 — 할 일만 있으면 그 문장', () => {
  assert.equal(say({ action: 'x', payload: { plain: { task: '고객 3명에게 답장 보내기' } } }), '고객 3명에게 답장 보내기');
});

test('요약 — 조직 문서 제안은 문서 제목으로', () => {
  assert.equal(say({ kind: 'org_doc', action: 'propose', payload: { title: '휴가 규칙', path: 'rules/vacation.md' } }), "조직 문서 '휴가 규칙' 저장");
});

test('요약 — 연결 서비스 쓰기는 서비스·도구 이름으로', () => {
  assert.equal(say({ kind: 'connector', action: 'notion · create_page', payload: { serverId: 'notion', tool: 'create_page' } }), 'notion에서 create_page 실행(외부 서비스에 쓰기)');
});

test('요약 — 셸 결재는 실행할 명령', () => {
  assert.equal(say({ kind: 'action', action: 'rm -rf build', payload: { shell: true } }), '명령 실행: rm -rf build');
});

test('요약 — 아무 재료도 없으면 기존 제목(action) 그대로', () => {
  assert.equal(say({ action: '경쟁사 리포트 업로드', reason: '분기 보고' }), '경쟁사 리포트 업로드');
});

test('요약 — 손상 데이터(문자열 아닌 값)는 건너뛰고 기존 제목으로(화면이 죽지 않게)', () => {
  assert.equal(say({ action: '단독 결재', payload: { plain: { purpose: {}, task: [] }, title: 3 }, kind: 'org_doc' }), '단독 결재');
  assert.equal(say({ action: { bad: 1 } }), '');
});

test('결재 페이지 — 대기 중인 결재 카드와 넣기 요청만, 방금 결정한 것은 빼고, 최신이 위', () => {
  const items = [
    { key: 'approval:1', kind: 'approval', at: '2026-10-02T01:00:00Z' },
    { key: 'crewjoin:2', kind: 'join', at: '2026-10-02T03:00:00Z' },
    { key: 'approval:3', kind: 'approval', at: '2026-10-02T02:00:00Z', status: 'approved' },
    { key: 'approval:4', kind: 'approval', at: '2026-10-02T04:00:00Z' },
    { key: 'approval:1', kind: 'approval', at: '2026-10-02T01:00:00Z' },
    { key: 'note:5', kind: 'mention', at: '2026-10-02T05:00:00Z' },
  ];
  assert.deepEqual(approvalPageItems(items, { done: new Set(['approval:4']) }).map((x) => x.key), ['crewjoin:2', 'approval:1']);
  assert.deepEqual(approvalPageItems(null).length, 0);
});
