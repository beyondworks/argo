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
