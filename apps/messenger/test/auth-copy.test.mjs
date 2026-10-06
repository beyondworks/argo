// UX 판독 UXM-23(2026-10-05): Argo 클라우드 사용자에게 '서버 관리자에게 문의'라고 안내했다 — 클라우드는 사용자가 연락할 서버 관리자가 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../src/i18n.js';
import * as O from '../src/oauth-handoff.mjs';

test('UXM-23 로그인 방법 확인 실패 문구 — 클라우드는 서버 관리자 대신 문의하기 안내, 직접 연결한 서버는 종전대로', () => {
  assert.equal(typeof O.providerErrorKey, 'function');
  assert.equal(O.providerErrorKey('restricted', { custom: false }), 'auth.providers.restricted.cloud');
  assert.equal(O.providerErrorKey('failed', { custom: false }), 'auth.providers.failed.cloud');
  assert.equal(O.providerErrorKey('restricted', { custom: true }), 'auth.providers.restricted');
  assert.equal(O.providerErrorKey('offline', { custom: false }), 'auth.providers.offline', '서버 관리자를 말하지 않는 문구는 그대로');
  for (const lang of ['ko', 'en']) for (const k of ['auth.providers.restricted.cloud', 'auth.providers.failed.cloud']) {
    assert.notEqual(t(k, lang), k); assert.doesNotMatch(t(k, lang), /관리자|administrator/i);
  }
});
