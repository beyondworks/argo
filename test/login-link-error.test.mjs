// 앱 로그인 화면의 기기 링크 실패 문구 — 서버가 준 kind로 표시 언어(ko/en) 문구를 고르고 code를 작게 붙인다.
// 서버 error(ko 고정)는 kind를 모르는 예전 응답용 폴백이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { linkErrorView } from '../app/link-error.mjs';

const i18n = await readFile(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
// 사전을 흉내 내지 않고 실제 i18n.jsx에서 키의 ko/en 쌍을 읽는다
const pair = (k) => { const m = i18n.match(new RegExp(`'${k.replace(/\./g, '\\.')}': \\['([^']+)', '([^']+)'\\]`)); return m && { ko: m[1], en: m[2] }; };
const t = (lang) => (k) => pair(k)?.[lang] ?? k;

test('kind별로 표시 언어 문구를 고른다 — en은 한글 없음, ko는 서버 안내와 같은 뜻', () => {
  for (const kind of ['unreachable', 'rejected', 'unknown']) {
    const en = linkErrorView({ kind, error: '서버 ko 문구' }, t('en'));
    const ko = linkErrorView({ kind, error: '서버 ko 문구' }, t('ko'));
    assert.ok(en.text && !/[가-힣]/.test(en.text), `${kind} en: ${en.text}`);
    assert.ok(/[가-힣]/.test(ko.text), `${kind} ko: ${ko.text}`);
    assert.notEqual(en.text, '서버 ko 문구');
  }
  assert.match(linkErrorView({ kind: 'unreachable' }, t('en')).text, /Supabase/);
});

test('code가 있으면 별도 필드로 돌려준다(작은 글씨용), 없으면 빈 값', () => {
  assert.equal(linkErrorView({ kind: 'unreachable', code: 'ECONNREFUSED' }, t('en')).code, 'ECONNREFUSED');
  assert.equal(linkErrorView({ kind: 'rejected' }, t('en')).code, '');
});

test('예전 서버 응답(kind 없음) — error 문구를 그대로 쓴다', () => {
  assert.deepEqual(linkErrorView({ error: '옛 문구' }, t('en')), { text: '옛 문구', code: '' });
});

test('login.link* 키는 i18n.jsx에 ko/en 쌍으로 등록돼 있다', () => {
  for (const k of ['login.linkUnreachable', 'login.linkRejected', 'login.linkUnknown']) assert.ok(pair(k), `${k} ko/en`);
});
