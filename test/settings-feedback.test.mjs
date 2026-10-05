// F9·F10·F12(2026-10-05 분리 검증) — 설정 화면의 실패 표시 규칙.
// F9: 크루 응답 언어·기본 러너 저장이 실패해도 화면은 바뀐 값이었다 → 되돌린다.
// F10: 동기화 오류가 내부 원문(한국어 고정·회사 id)으로만 보였다 → 사용자 문구 키 + 할 일.
// F12: 보관함 조회 실패를 '비어 있습니다'로 보였다 → 오류 + 다시 시도.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveWithRevert } from '../app/c/[ws]/settings/save-revert.mjs';
import { syncErrorView } from '../app/c/[ws]/settings/sync-error.mjs';
import { listView } from '../app/lib/list-view.mjs';
import { syncFailedMessage } from '../src/sync.mjs';

test('F9: 저장 실패(거절·예외)면 이전 값으로 되돌리고, 성공이면 바뀐 값 그대로', async () => {
  const seen = [];
  assert.equal(await saveWithRevert({ prev: 'ko', next: 'en', apply: (v) => seen.push(v), save: async () => false }), false);
  assert.deepEqual(seen, ['en', 'ko'], '누르는 즉시 en, 실패해서 ko로');
  seen.length = 0;
  assert.equal(await saveWithRevert({ prev: '', next: 'codex', apply: (v) => seen.push(v), save: async () => { throw new TypeError('fetch failed'); } }), false);
  assert.deepEqual(seen, ['codex', '']);
  seen.length = 0;
  assert.equal(await saveWithRevert({ prev: 'ko', next: 'en', apply: (v) => seen.push(v), save: async () => true }), true);
  assert.deepEqual(seen, ['en']);
});

test('F10: 동기화 원문 → 사용자 문구 키(회사 id·내부 사유 노출 없음) — 엔진이 실제로 만드는 문장으로 대조', () => {
  const files = syncFailedMessage('co-abc', { failed: 4, failures: [{ rel: 'vault/a.md', reason: 'CDN stale' }] });
  assert.deepEqual(syncErrorView(files), { key: 'settings.sync.err.files', vars: { n: 4 } });
  assert.equal(syncErrorView('동기화 자격 없음/만료 — 재로그인 필요').key, 'settings.sync.err.auth');
  assert.equal(syncErrorView('같은 데이터 루트를 다른 프로세스가 동기화 중 — 이 인스턴스는 대기').key, 'settings.sync.err.otherProcess');
  assert.deepEqual(syncErrorView('co-abc: 계정 키 미확보 — 파일 3개 동기화 보류(재시도 중)'), { key: 'settings.sync.err.accountKey', vars: { n: 3 } });
  assert.equal(syncErrorView('co-abc: fetch failed').key, 'settings.sync.err.network');
  assert.equal(syncErrorView('co-abc: 알 수 없는 오류').key, 'settings.sync.err.generic');
  assert.equal(syncErrorView(''), null);
  const i18n = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  for (const k of ['files', 'auth', 'otherProcess', 'accountKey', 'network', 'generic']) {
    assert.match(i18n, new RegExp(`'settings\\.sync\\.err\\.${k}': \\['[^']+', "?'?[^\\]]+\\]`), `${k} ko·en 문구`);
  }
});

test('F12: 보관함 조회 실패는 "비어 있음"이 아니라 오류', () => {
  assert.equal(listView(null, true), 'error');
  assert.equal(listView([], false), 'empty');
  assert.equal(listView(null, false), 'loading');
  assert.equal(listView([{ id: 1 }], true), 'list');
});
