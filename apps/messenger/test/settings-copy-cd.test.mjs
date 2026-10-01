// 설정 문구(UX 점검 C·D) — 조직 없는 계정의 계정 카드, "정한 사람만" 안내, 에이전트 규칙 설명.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../src/i18n.js';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('조직 없는 계정 — 계정 설명에 "이 조직" 없이 개인 공간 문장, 이름 자리에 "—"를 그리지 않는다', () => {
  assert.doesNotMatch(t('set.account.desc.personal', 'ko'), /조직/); assert.doesNotMatch(t('set.account.desc.personal', 'en'), /organization/i);
  assert.match(t('set.account.desc', 'ko'), /이 조직/); // 조직 안에서는 그대로
  assert.match(app, /<p>\{t\(org \? 'set\.account\.desc' : 'set\.account\.desc\.personal'\)\}<\/p>/);
  assert.match(app, /\{\(org \|\| me\?\.display_name\) && <span style=\{\{ fontWeight: 600 \}\}>\{me\?\.display_name \|\| '—'\}<\/span>\}/);
});

test('"정한 사람만" — 사람 고르는 칸은 정책에 저장할 곳이 없어(서버 열 없음) 안내 한 줄로, 에이전트 시트에서 고른다고 알린다', () => {
  assert.match(t('set.policy.allow.listNote', 'ko'), /에이전트 시트/); assert.match(t('set.policy.allow.listNote', 'en'), /agent sheet/i);
  assert.match(app, /draft\.allow_default === 'list' && <span className="note">\{t\('set\.policy\.allow\.listNote'\)\}<\/span>/);
});

test('조직 없는 계정의 AI 동의 카드 제목에도 "조직 공간"이 없다(개인 공간 게이트 제목을 쓴다)', () => {
  assert.doesNotMatch(t('consent.ai.personal.title', 'ko'), /조직/); assert.doesNotMatch(t('consent.ai.personal.title', 'en'), /organization/i);
  assert.match(app, /<h2>\{t\(org \|\| orgs\.length \? 'consent\.ai\.title' : 'consent\.ai\.personal\.title'\)\}<\/h2>/);
});
