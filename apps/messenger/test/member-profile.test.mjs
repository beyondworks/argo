// 멤버 화면 부서·직급 — 본인만 정한다(유건 2026-09-24: "직급이나 부서는 본인이 정하는거라 나 말고 다른 사람들껀 편집 포인트 없어도 돼").
// 서버 규칙은 test/msgr-memory-boundary-pg.test.mjs(루트)가 실 Postgres로 잠근다. 여기는 화면 배선.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const comp = src.slice(src.indexOf('function MemberProfile('), src.indexOf('function MemberListCard('));

test('한 컴포넌트가 정한다 — 남은 글자, 나만 입력칸, 저장은 언제나 내 id로', () => {
  assert.match(comp, /if \(m\.user_id !== uid\) return [^;]*msgr-profile-text/);
  assert.match(comp, /member: uid,/, '남의 id로 저장 요청을 만들 수 없다');
});

test('관리자·비관리자 멤버 탭 모두 같은 컴포넌트(재검수 #699 H1 — 비관리자 갈래엔 칸이 없었다)', () => {
  assert.equal(src.match(/<MemberProfile /g)?.length, 2, 'OrgCard 멤버 행 + MemberListCard');
  assert.match(src, /: <MemberListCard org=\{org\}/, '비관리자 갈래');
  assert.doesNotMatch(src, /orgAdmin && profiles/);
});
