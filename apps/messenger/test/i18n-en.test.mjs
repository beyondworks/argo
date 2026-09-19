// en 문구 복수형·관사(D44) — '1 people · 0 agents', 'Mention a agent'. 한국어 문구는 그대로.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../src/i18n.js';

test('{n|one|other} — 1이면 단수, 나머지는 복수, 한국어는 그대로', () => {
  assert.equal(t('ch.who.count', 'en', { p: 1, c: 0 }), '1 person · 0 agents');
  assert.equal(t('ch.who.count', 'en', { p: 2, c: 1 }), '2 people · 1 agent');
  assert.equal(t('ch.who.count', 'ko', { p: 1, c: 0 }), '1명 · 에이전트 0');
  assert.equal(t('search.count', 'en', { n: 1 }), '1 result');
  assert.equal(t('inv.days', 'en', { n: 1 }), '1 day');
  assert.equal(t('inv.m.uses', 'en', { used: 0, max: 1 }), '0/1 use');
  assert.equal(t('exec.meta', 'en', { s: '3s', n: 1 }), '3s · 1 tool call');
  assert.equal(t('automation.every', 'en', { n: 5 }), 'Every 5 minutes');
});

test('모든 en 문구 — "a agent" 없음, 숫자 자리 뒤 복수 명사는 복수형 문법을 쓴다', () => {
  const src = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  const en = [...src.matchAll(/^\s*'([^']+)':\s*\[\s*(['"])(?:(?!\2).)*\2\s*,\s*(['"])((?:(?!\3).)*)\3/gm)].map((m) => [m[1], m[4]]);
  assert.ok(en.length > 500, `en 문구 ${en.length}개를 읽는다`);
  assert.deepEqual(en.filter(([, v]) => /\b[Aa] agent/.test(v)).map(([k]) => k), [], 'an agent');
  // 숫자 자리({n}·{p}·{c}·{used}·{max}·{days}) 바로 뒤의 알려진 복수 명사는 {x|단수|복수}로
  const nouns = 'people|agents|days|minutes|results|members|channels|uses|invites|calls|links';
  const bad = en.filter(([, v]) => new RegExp(`\\{(n|p|c|used|max|days)\\} (${nouns})\\b`).test(v)).map(([k, v]) => `${k}: ${v}`);
  assert.deepEqual(bad, []);
});

test('빈 방 문구 — 에이전트가 있는 방만 @ 안내, 채널 없는 조직 상단은 채널 없음', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /t\(chCrews\.length && channel\.kind !== 'dm' \? 'ch\.empty' : 'ch\.empty\.plain'\)/);
  assert.match(app, /<span className="topic">\{org \? t\('ch\.noneYet\.short'\) : t\('org\.none'\)\}<\/span>/);
});
