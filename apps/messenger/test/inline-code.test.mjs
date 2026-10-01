// 에이전트·서버 탭(UX 점검 D) — 문구 속 `백틱`이 글자 그대로 찍히던 것을 코드 표시로, "노드"를 "서버"로 통일,
// 환경변수 이름·파일 경로는 복사해 쓰는 코드 안에만 남긴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitInlineCode } from '../src/inline-code.mjs';

test('splitInlineCode — 백틱 쌍은 코드 조각, 나머지는 글', () => {
  assert.deepEqual(splitInlineCode('실행: `hermes gateway run` 하세요'), [{ text: '실행: ' }, { code: 'hermes gateway run' }, { text: ' 하세요' }]);
  assert.deepEqual(splitInlineCode('`a`와 `b`'), [{ code: 'a' }, { text: '와 ' }, { code: 'b' }]);
  assert.deepEqual(splitInlineCode('백틱 없음'), [{ text: '백틱 없음' }]);
  assert.deepEqual(splitInlineCode(''), []);
  assert.deepEqual(splitInlineCode(null), []);
});

test('splitInlineCode — 짝이 안 맞는 백틱은 글자 그대로 둔다(내용을 잃지 않는다)', () => {
  assert.deepEqual(splitInlineCode('한 개 ` 뿐'), [{ text: '한 개 ` 뿐' }]);
  assert.deepEqual(splitInlineCode('`a` 그리고 ` 끝'), [{ code: 'a' }, { text: ' 그리고 ` 끝' }]);
});

const src = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
const entries = [...src.matchAll(/^\s*'([^']+)':\s*\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*(["'])((?:(?!\3)[^\\]|\\.)*)\3/gm)].map((m) => ({ key: m[1], ko: m[2], en: m[4] }));
const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('i18n 항목을 읽었다(검사가 비어 있지 않다)', () => assert.ok(entries.length > 800, `${entries.length}`));

test('백틱이 든 문구는 전부 InlineCode로 그리는 키뿐 — 날것으로 찍히는 키가 없다', () => {
  const withTicks = entries.filter((e) => e.ko.includes('`') || e.en.includes('`')).map((e) => e.key);
  assert.ok(withTicks.length >= 4, withTicks.join(','));
  for (const key of withTicks) {
    const ok = key.startsWith('org.agents.setup.') || key === 'org.agents.openclaw.outdated';
    assert.ok(ok, `${key}: 새 백틱 문구는 InlineCode로 그릴 곳을 정하고 여기에 등록한다`);
  }
  assert.match(app, /<li><InlineCode text=\{t\(`org\.agents\.setup\.\$\{setup\.kind \?\? 'custom'\}\.1`\)\} \/><\/li>/);
  assert.match(app, /<InlineCode text=\{t\('org\.agents\.openclaw\.outdated'/);
});

test('"노드"는 한국어 화면에, "node"는 영어 화면에 없다 — 같은 기능은 "서버"/"server"로 통일', () => {
  assert.deepEqual(entries.filter((e) => e.ko.includes('노드')).map((e) => e.key), []);
  assert.deepEqual(entries.filter((e) => /\bnodes?\b/i.test(e.en)).map((e) => e.key), []);
});

test('일반 설명 문장에는 환경변수 이름·파일 경로가 없다(코드 표시 안에만)', () => {
  const plain = (s) => s.replace(/`[^`]*`/g, '');
  const re = /ARGO_[A-Z_]+|~\/|\.env\b|integrations\/|\.hermes|\.openclaw/;
  const ALLOW = new Set(['auth.notConfigured']); // 서버 주소 없이 만든 개발·셀프 빌드에서만 나오는 설정 안내 — 파일 이름이 안내의 핵심
  const bad = entries.filter((e) => !ALLOW.has(e.key) && (re.test(plain(e.ko)) || re.test(plain(e.en)))).map((e) => e.key);
  assert.deepEqual(bad, []);
});

test('외부 에이전트 안내에 크루·파견 같은 안 쓰는 말이 없다', () => {
  for (const key of ['org.agents.desc']) { const e = entries.find((x) => x.key === key); assert.doesNotMatch(e.ko, /크루|파견/); assert.doesNotMatch(e.en, /\bcrews?\b|dispatch/i); }
});
