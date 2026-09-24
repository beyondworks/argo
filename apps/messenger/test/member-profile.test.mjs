// 멤버 화면 부서·직급 — 본인만 정한다(유건 2026-09-24: "직급이나 부서는 본인이 정하는거라 나 말고 다른 사람들껀 편집 포인트 없어도 돼").
// 서버 규칙은 test/msgr-memory-boundary-pg.test.mjs(루트)가 실 Postgres로 잠근다. 여기는 화면 배선.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const block = src.slice(src.indexOf("if (part === 'members')"), src.indexOf("<h3>{t('org.invites.h')}</h3>"));

test('입력칸은 내 행에만, 남의 부서·직급은 글자로', () => {
  assert.match(block, /profiles && !isSvc && isMe && <span className="msgr-profile">/);
  assert.match(block, /profiles && !isSvc && !isMe && [^<]*<span className="sub msgr-profile-text">/);
  assert.doesNotMatch(block, /orgAdmin && profiles/, '관리자라고 남의 칸을 열지 않는다');
});

test('부서·직급은 관리자가 아니어도 불러온다(내 칸·남의 글자 표시)', () => {
  assert.match(src, /if \(part === 'members'\) loadProfiles\(\)/);
});
