// AI 이용 동의 문구(UX 점검 C·D) — "크루"를 메신저 홈과 같은 "에이전트"로, 조직이 없는 계정에는 "이 조직" 대신 개인 공간 문장,
// 동의 철회는 무엇이 잠기는지 적은 확인 창을 거친다(window.confirm 금지 — 메신저의 ConfirmModal).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../src/i18n.js';
import { aiConsentCopy } from '../src/consent-copy.mjs';

const sentences = (s) => (s.replace(/e\.g\./g, 'e.g').match(/[.。]\s|[.。]$/g) ?? []).length; // 'e.g.'의 점은 문장 끝이 아니다

test('동의 화면 설명 — 크루·봇이 아니라 에이전트, 두 문장 이내(ko·en)', () => {
  for (const key of ['consent.ai.desc', 'consent.ai.personal.desc']) {
    const ko = t(key, 'ko'); const en = t(key, 'en');
    assert.doesNotMatch(ko, /크루|봇/, `${key} ko: ${ko}`);
    assert.doesNotMatch(en, /\bcrews?\b|\bbots?\b/i, `${key} en: ${en}`);
    assert.match(ko, /에이전트/);
    assert.ok(sentences(ko) <= 2, `${key} ko ${sentences(ko)}문장`);
    assert.ok(sentences(en) <= 2, `${key} en ${sentences(en)}문장`);
    assert.match(ko, /Anthropic/, '데이터가 가는 곳(외부 AI 서비스 이름)은 그대로 밝힌다'); // 애플 5.1.2 공개 의무
  }
});

test('상태 문구 — 조직이 있으면 조직 문장, 없으면(개인 공간) 조직 단어가 없다', () => {
  for (const lang of ['ko', 'en']) for (const consented of [true, false]) {
    const org = aiConsentCopy({ consented, hasOrg: true }); const solo = aiConsentCopy({ consented, hasOrg: false });
    for (const key of [org.status, solo.status]) assert.doesNotMatch(t(key, lang), /크루|\bcrews?\b/i, `${key} ${lang}`);
    assert.match(t(org.status, lang), lang === 'ko' ? /조직/ : /organization/i);
    assert.doesNotMatch(t(solo.status, lang), lang === 'ko' ? /조직/ : /organization/i, `${solo.status} ${lang}`);
  }
});

test('철회 확인 문구 — 조직이 있으면 조직 공간이 잠긴다고, 없으면 에이전트와 못 쓴다고 적는다', () => {
  const org = aiConsentCopy({ consented: true, hasOrg: true }); const solo = aiConsentCopy({ consented: true, hasOrg: false });
  assert.match(t(org.revokeDesc, 'ko'), /잠겨/); assert.match(t(org.revokeDesc, 'ko'), /다시 동의/);
  assert.match(t(org.revokeDesc, 'en'), /locked/i);
  assert.doesNotMatch(t(solo.revokeDesc, 'ko'), /조직/); assert.match(t(solo.revokeDesc, 'ko'), /에이전트/); assert.match(t(solo.revokeDesc, 'ko'), /친구/);
  assert.ok(t('set.aiConsent.revoke.title', 'ko').length > 0 && t('set.aiConsent.revoke.title', 'en').length > 0);
});

test('동의하지 않은 상태에서는 철회 문구가 필요 없다(버튼은 "지금 동의")', () => {
  assert.equal(aiConsentCopy({ consented: false, hasOrg: true }).revokeDesc, null);
});

test('앱: 철회는 ConfirmModal을 거치고(바로 적용 안 함), 설정 행은 조직 유무로 문구를 고른다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const row = app.slice(app.indexOf('function AiConsentRow('), app.indexOf('/* ─── F2-1·2·3·4'));
  assert.match(row, /<ConfirmModal title=\{t\('set\.aiConsent\.revoke\.title'\)\} description=\{t\(copy\.revokeDesc\)\}/);
  assert.doesNotMatch(row, /window\.confirm|confirm\(/);
  assert.match(row, /onClick=\{aiConsented \? \(\) => setAsk\(true\) : toggle\}/, '동의 상태에서 누르면 창만 열고, 동의 안 한 상태에서는 바로 동의');
  assert.match(app, /<AiConsentRow t=\{t\} onError=\{onError\} hasOrg=\{!!org \|\| orgs\.length > 0\} \/>/);
});
