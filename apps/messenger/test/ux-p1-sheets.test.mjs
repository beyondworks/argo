// UX 정리 P1 묶음 4 시트(2026-10-22): 에이전트 추가 패널 안내는 한 번에 하나, 카드 시트 대화·요청 줄은 머리 바로 아래, 채널 시트 '내보낸 사람' 목록은 설정 접힘 안.
// 판정은 src/crew-add-note.mjs(행동 시험), 배치는 App.jsx 소스 배선 — 화면은 픽스처에서 개인·조직 × 390·1280 × 라이트·다크로 눌렀다(PR 본문 표).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crewAddNoteKey } from '../src/crew-add-note.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('안내 하나: 후보가 없으면 "없음"(실행기 연결)', () => {
  assert.equal(crewAddNoteKey({ rows: 0, anyApproval: true, anyDispatch: true }), 'none');
  assert.equal(crewAddNoteKey(), 'none');
});

test('안내 하나: 안 골랐으면 목록에 있는 것 — 승인 → 비공개 방 회사 → 파견 순', () => {
  assert.equal(crewAddNoteKey({ rows: 3, anyApproval: true, anyCompany: true, anyDispatch: true, privateRoom: true }), 'approval');
  assert.equal(crewAddNoteKey({ rows: 3, anyCompany: true, anyDispatch: true, privateRoom: true }), 'company');
  assert.equal(crewAddNoteKey({ rows: 3, anyCompany: true, anyDispatch: true, privateRoom: false }), 'dispatch', '공개 방은 회사 안내를 안 띄운다');
  assert.equal(crewAddNoteKey({ rows: 3 }), null, '해당 사항이 없으면 안내 없음');
});

test('안내 하나: 고르면 고른 것에 맞춘다 — 목록 안내로 되돌아가지 않는다', () => {
  assert.equal(crewAddNoteKey({ rows: 3, picked: 1, pickedDispatch: true, anyApproval: true }), 'dispatch', '고른 파견이 목록의 승인보다 먼저');
  assert.equal(crewAddNoteKey({ rows: 3, picked: 2, pickedApproval: true, pickedDispatch: true }), 'approval');
  assert.equal(crewAddNoteKey({ rows: 3, picked: 1, pickedCompany: true, privateRoom: true, pickedDispatch: true }), 'company');
  assert.equal(crewAddNoteKey({ rows: 3, picked: 1, anyApproval: true, anyDispatch: true }), null, '고른 것에 해당 안내가 없으면 없음');
});

test('배선: 추가 패널은 방 규칙 안내를 늘 두고, 나머지는 crewAddNoteKey 하나로만 고른다', () => {
  const s = app.indexOf("t('ch.add.crew.shared')"); assert.ok(s > 0);
  const panel = app.slice(s - 200, s + 2200);
  assert.match(panel, /rows\.length > 0 && <p className="note">\{t\('ch\.add\.crew\.shared'\)\}/, '방 규칙 안내(9/18 동의 화면)는 조건 없이 늘 보인다');
  assert.match(panel, /crewAddNoteKey\(\{/);
  for (const k of ['ch.add.crew.none', 'ch.crew.join.note', 'ch.add.mine.note', 'ch.add.crew.note']) {
    const n = app.split(`'${k}'`).length - 1;
    assert.ok(n >= 1, k);
    assert.ok(panel.includes(`'${k}'`), `${k}는 안내 하나 블록 안에서만 그려진다`);
  }
  assert.equal((panel.match(/<p className="note">/g) ?? []).length, 4, '안내 <p>는 늘 두는 1개 + 고른 하나(none·approval·그 밖) 3갈래');
});

test('배선: 카드 시트 대화·요청 줄은 머리 바로 아래, 사실 표 위', () => {
  const sheet = app.slice(app.indexOf('<aside className="msgr-crewsheet"'));
  const head = sheet.indexOf('<div className="head">'); const me = sheet.indexOf('<div className="me me-top">'); const facts = sheet.indexOf('<div className="facts">');
  assert.ok(head >= 0 && me > head && facts > me, `head(${head}) < me-top(${me}) < facts(${facts})`);
  assert.equal(sheet.slice(0, sheet.indexOf('</aside>')).split('className="me').length - 1, 1, '대화 단추 줄은 한 번만');
});

test('배선: 내보낸 사람 목록은 채널 시트 설정 접힘({more && …}) 안에 있다', () => {
  const fold = app.indexOf("t(isPersonal ? 'personal.sheet.settings' : 'ch.settings')");
  const more = app.indexOf('{more && (<>', fold); const ex = app.indexOf("t('ch.excluded')");
  assert.ok(fold > 0 && more > fold && ex > more, `설정 머리(${fold}) < 접힘 시작(${more}) < 내보낸 목록(${ex})`);
  assert.equal(app.split("t('ch.excluded')").length - 1, 1, '내보낸 목록은 한 곳뿐(구성원 목록에서 빠졌다)');
});
