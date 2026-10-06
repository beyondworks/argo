// 용어 변경 T1(2026-10-05): 활동 화면에서 사용자가 멈춘 턴은 저장된 원문 대신 화면 언어 문구로 보인다.
// 새 이벤트는 aborted 필드, 필드가 없던 옛 이벤트는 옛 문자열('사장 지시로 중단')로 판정한다(src/legacy-terms.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { turnErrorDesc } from '../app/c/[ws]/activity/turn-desc.mjs';

const dict = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
const entry = (key) => { const m = dict.match(new RegExp(`'${key.replace(/\./g, '\\.')}':\\s*\\[(["'])((?:(?!\\1).)*)\\1,\\s*(["'])((?:(?!\\3).)*)\\3\\]`)); return m ? [m[2], m[4]] : null; };

test('중단 표시 — 새 필드·새 문자열·옛 문자열 모두 사전 문구, 그 밖의 오류는 원문 그대로', () => {
  const t = (k) => `⟨${k}⟩`;
  assert.equal(turnErrorDesc({ ok: false, aborted: true, error: '사용자 지시로 중단' }, t), '⟨activity.aborted⟩');
  assert.equal(turnErrorDesc({ ok: false, error: '사용자 지시로 중단' }, t), '⟨activity.aborted⟩');
  assert.equal(turnErrorDesc({ ok: false, error: '사장 지시로 중단' }, t), '⟨activity.aborted⟩', '옛 이벤트(필드 없음)');
  assert.equal(turnErrorDesc({ ok: false, error: 'rate limit' }, t), 'rate limit');
});

test('activity.aborted 사전 — ko·en 둘 다, en에 한글 없음, 옛 낱말 없음', () => {
  const [ko, en] = entry('activity.aborted') ?? [];
  assert.ok(ko && en, 'activity.aborted 항목');
  assert.doesNotMatch(en, /[가-힣]/);
  assert.doesNotMatch(ko, /사장|크루/);
});

test('기억 카드(D2) — 제목만 "회사가 아는 사용자", 파일 경로 notes/사장-프로필.md는 그대로', () => {
  const [ko, en] = entry('chat.boss.title') ?? [];
  assert.match(ko, /^회사가 아는 사용자/);
  assert.equal(en, 'What the company knows about you');
  const memory = readFileSync(new URL('../src/memory.mjs', import.meta.url), 'utf8');
  assert.match(memory, /notes\/사장-프로필\.md/, '경로 유지(계획 8절 질문 2) — 옮기면 옛 기기와 파일이 둘로 갈린다');
});

test('회사 삭제(C2) — 문구는 삭제, 확인 문구도 삭제, 되돌리기 안내는 홈을 가리킨다', () => {
  assert.deepEqual(entry('settings.archive.title'), ['회사 삭제', 'Delete Company']);
  assert.deepEqual(entry('danger.phrase.archive'), ['삭제하겠습니다', 'delete this']);
  const desc = dict.split('\n').find((l) => l.includes("'settings.archive.desc'"));
  assert.match(desc, /되돌릴 수 있습니다/); assert.match(desc, /can restore it/);
  for (const key of ['settings.archived.title', 'home.archived.entry', 'settings.archived.when']) {
    const vals = entry(key);
    assert.ok(vals, key);
    for (const v of vals) assert.doesNotMatch(v, /보관|[Aa]rchiv/, `${key}: 회사 목록 문구는 '삭제'로`);
  }
});

test('0.1.96 업데이트 안내에 용어 변경 항목, 0.1.95 항목은 그대로', async () => {
  const { UPDATE_NOTES } = await import('../app/update-notes-state.mjs');
  assert.ok(UPDATE_NOTES['0.1.96'].includes('updates.note.agentRename'));
  assert.ok(!UPDATE_NOTES['0.1.95'].includes('updates.note.agentRename'), '0.1.95는 핫픽스로 따로 발행 — 손대지 않는다');
  assert.ok(entry('updates.note.agentRename'), 'ko·en 사전 항목');
});

// T6 발견(2026-10-05): 설정 위험 구역의 회사 삭제 카드 설명에 되돌리기 안내가 없었다(확인 창에만 있음, 0.1.95도 같음).
test('회사 삭제 카드 설명 — 되돌리기 안내(ko·en)가 카드 설명 안에 나온다', () => {
  const [ko, en] = entry('settings.archive.restoreHint') ?? [];
  assert.ok(ko && en, 'settings.archive.restoreHint ko·en');
  assert.match(ko, /되돌릴 수 있습니다/); assert.match(ko, /삭제한 회사/);
  assert.match(en, /restore/); assert.match(en, /Deleted companies/); assert.doesNotMatch(en, /[가-힣]/);
  const page = readFileSync(new URL('../app/c/[ws]/settings/page.jsx', import.meta.url), 'utf8');
  const desc = page.match(/\{t\('settings\.archive\.pathPrefix'\)\}[\s\S]*?<\/p>/)?.[0] ?? '';
  assert.match(desc, /\{t\('settings\.archive\.restoreHint'\)\}/, '삭제 카드 설명 문단 안에 되돌리기 안내');
});
