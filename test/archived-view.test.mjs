// UM3·UL1(2026-10-05 분리 검수):
// UM3 — 보관한 회사 되돌리기 입구가 회사별 설정 '위험 구역' 안에만 있었다. 회사가 하나뿐인 사용자가 그 회사를 보관하면 빈 온보딩만 남아 되돌릴 길이 없었다
//       → 홈(온보딩 포함)에 '보관한 회사 n개 · 되돌리기' 입구. 보관 안내 문구도 이미 없는 회사의 설정을 가리키지 않게.
// UL1 — 되돌리기 409(같은 id 회사가 이미 목록에 있음) 문구가 "같은 이름"이라 실제와 다르고 다음 행동이 없으며 버튼이 남아 같은 실패를 반복했다
//       → 실제 원인 문구 + 그 행은 '열기'로 바꾼다(버튼 제거).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreFailKind, archivedRowState, archivedEntryCount } from '../app/lib/archived-view.mjs';
import { API_MSG } from '../app/apimsg.mjs';

test('되돌리기 실패 분류 — 이미 같은 회사가 있으면(409 archive_restore_exists) 다시 눌러도 같은 결과', () => {
  assert.equal(restoreFailKind({ data: { errorCode: 'archive_restore_exists' }, status: 409 }), 'exists');
  assert.equal(restoreFailKind({ data: { errorCode: 'archive_restore_failed' }, status: 500 }), 'failed');
  assert.equal(restoreFailKind({ data: { errorCode: 'archive_not_found' }, status: 404 }), 'failed');
  assert.equal(restoreFailKind(new TypeError('fetch failed')), 'failed');
  assert.equal(restoreFailKind(null), 'failed');
});

test('행 상태 — 같은 id 회사가 이미 목록에 있거나 방금 409를 받은 행은 되돌리기 대신 열기', () => {
  const it = { archiveId: '1-co-a', wsId: 'co-a' };
  assert.equal(archivedRowState(it, { blocked: new Set(), existingIds: new Set() }), 'restorable');
  assert.equal(archivedRowState(it, { blocked: new Set(['1-co-a']), existingIds: new Set() }), 'exists', '방금 409를 받았다');
  assert.equal(archivedRowState(it, { blocked: new Set(), existingIds: new Set(['co-a']) }), 'exists', '홈 목록에 이미 있다 — 눌러 보기 전에 안다');
  assert.equal(archivedRowState(it, {}), 'restorable', '정보가 없으면 시도할 수 있다');
});

test('홈 입구 — 보관한 회사가 1개 이상일 때만 센다(목록을 못 받았으면 입구를 만들지 않는다)', () => {
  assert.equal(archivedEntryCount([{ archiveId: 'a' }, { archiveId: 'b' }]), 2);
  assert.equal(archivedEntryCount([]), 0);
  assert.equal(archivedEntryCount(null), 0);
  assert.equal(archivedEntryCount(undefined), 0);
});

test('409 문구는 실제 원인(같은 회사가 이미 있음)과 다음 행동(목록에서 열기)을 말한다 — "같은 이름"이 아니다', () => {
  const m = API_MSG.archive_restore_exists;
  assert.equal(m.status, 409);
  assert.match(m.ko, /이미 목록에 같은 회사/); assert.match(m.ko, /열어 보세요/); assert.doesNotMatch(m.ko, /같은 이름/);
  assert.match(m.en, /already in your list/); assert.match(m.en, /open it/i); assert.doesNotMatch(m.en, /same name/);
});

test('보관 안내 문구는 이미 없는 회사의 설정이 아니라 홈의 보관한 회사를 가리킨다', async () => {
  const dict = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const line = dict.split('\n').find((l) => l.includes("'settings.archive.desc'"));
  assert.ok(line, 'settings.archive.desc 항목');
  assert.doesNotMatch(line, /위험 구역/, '보관하면 그 회사의 설정은 사라진다 — 거기서 되돌리라고 안내하지 않는다');
  assert.match(line, /홈/); assert.match(line, /Home/i);
});

// 2차 분리 검수 L1(2026-10-05): 되돌리기 실패 안내가 failureReason을 거치지 않아 네트워크 실패에 'Failed to fetch' 원문이 그대로 나왔다.
import { restoreFailMessage } from '../app/lib/archived-view.mjs';
test('L1: 되돌리기 실패 안내 — 네트워크 원문 대신 사유 문구, 같은 회사가 이미 있으면 사전 문구 그대로', () => {
  const dict = { 'settings.archived.restoreFailWhy': (a) => `되돌리지 못했습니다 — ${a.msg}`, 'common.reason.network': () => '네트워크 연결을 확인해 주세요', 'common.reason.server': () => '서버 문구', 'common.reason.unknown': () => '다음 행동' };
  const t = (key, a) => (dict[key] ? dict[key](a) : `⟨${key}⟩`);
  assert.equal(restoreFailMessage(new TypeError('Failed to fetch'), t), '되돌리지 못했습니다 — 네트워크 연결을 확인해 주세요');
  assert.equal(restoreFailMessage(Object.assign(new Error('x'), { status: 500, data: {} }), t), '되돌리지 못했습니다 — 서버 문구');
  const exists = Object.assign(new Error('이미 목록에 같은 회사가 있어 되돌릴 수 없습니다 — 목록에서 그 회사를 열어 보세요'), { status: 409, data: { errorCode: 'archive_restore_exists' } });
  assert.equal(restoreFailMessage(exists, t), exists.message, '사전 문구는 접두 없이 그대로');
});

// 2차 분리 검수 L2: 되돌리기 성공 안내가 0.3초 만에 사라졌다 — 마지막 보관 회사를 되돌리면 개수 0으로 카드가 사라지고, 온보딩에서는 입구가 다른 자리로 다시 마운트돼 카드 안 상태가 버려졌다.
import { restoreNote } from '../app/lib/archived-view.mjs';
import { readFileSync } from 'node:fs';
test('L2: 되돌리기 성공 안내는 홈 상태로 올라간다 — 카드 밖에서 그리고 열기 링크를 단다', () => {
  const t = (key, a) => (key === 'settings.archived.restored' ? `"${a.name}"을(를) 되돌렸습니다.` : `⟨${key}⟩`);
  assert.deepEqual(restoreNote({ name: '검수 회사', wsId: 'co-a' }, { wsId: 'co-a' }, t), { ok: true, text: '"검수 회사"을(를) 되돌렸습니다.', href: '/c/co-a' });
  const page = readFileSync(new URL('../app/page.jsx', import.meta.url), 'utf8');
  const card = readFileSync(new URL('../app/archived-companies.jsx', import.meta.url), 'utf8');
  assert.match(page, /onMessage=\{setArchivedMsg\}/, '홈이 카드의 안내를 받는다');
  assert.match(page, /\{archivedMsg && \(/, '홈이 안내를 카드 밖에서 그린다');
  assert.match(card, /const msg = onMessage \? null : localMsg;/, 'onMessage가 있으면 카드 안에 이중으로 그리지 않는다(설정은 카드 안)');
});
