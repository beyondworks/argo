// 팀 메신저 크루 등록 카드(F1-1) — 배선·라벨·기본값 핀. 화면 동작은 Aside 실측(로컬 스택)로.
//  · 카드가 설정의 "연결" 섹션에 실제로 렌더된다(슬랙 카드 뒤, 커넥터 카드 앞) — 컴포넌트만 있고 안 꽂히면 화면에 없다
//  · 라우트 기본 허용 범위 'owner'(부록 H: 정책 테이블 전까지 가장 좁게) + GET이 조직별 멤버(지정 멤버 선택지)를 준다
//  · 카드가 쓰는 i18n 키가 ko/en 둘 다 있다(다국어 상시 규칙)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './helpers/strip-comments.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const page = stripComments(read('app/c/[ws]/settings/page.jsx'));
const route = stripComments(read('app/api/companies/[ws]/msgr/route.js'));
const i18n = read('app/i18n.jsx');

test('MsgrCard가 연결 섹션에 꽂혀 있다 — 슬랙 카드 뒤·커넥터 카드 앞', () => {
  const slack = page.indexOf('kind="slack"');
  const card = page.indexOf('<MsgrCard ws={ws} agents={data?.agents ?? []} />');
  const conn = page.indexOf('<ConnectorsCard ws={ws} />');
  assert.ok(slack > 0 && card > 0 && conn > 0, '세 카드가 모두 있어야 한다');
  assert.ok(slack < card && card < conn, 'MsgrCard 위치가 어긋났다(슬랙 뒤·커넥터 앞)');
  assert.match(page, /function MsgrCard\(\{ ws, agents \}\)/, '컴포넌트 시그니처');
});

test('라우트: 기본 allow는 owner, GET은 조직별 members를 싣는다', () => {
  assert.match(route, /allow = 'owner'/, "POST 기본 허용 범위가 'owner'가 아니다 — 정책 테이블 전까지는 가장 좁게(부록 H)");
  assert.doesNotMatch(route, /allow = 'all'/, "'all' 기본값이 남아 있다");
  assert.match(route, /o\.members = /, 'GET 조직 목록에 members가 없다 — 카드의 지정 멤버 선택지가 빈다');
  assert.match(route, /\.neq\(|m\.user_id !== c\.uid/, '멤버 목록에서 본인을 빼야 한다');
});

test('카드가 쓰는 i18n 키는 전부 ko/en 쌍으로 있다', () => {
  const src = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function ConnectorsCard('));
  const keys = new Set([...src.matchAll(/t\('([a-z0-9.]+)'\)/g)].map((m) => m[1]));
  for (const v of ['all', 'list', 'owner']) keys.add(`settings.msgr.allow.${v}`);
  for (const r of ['owner', 'admin', 'member', 'guest']) keys.add(`role.${r}`);
  assert.ok(keys.size >= 18, `키 수집이 너무 적다(${keys.size})`);
  for (const k of keys) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} 라벨이 ko·en 둘 다 있어야 한다`);
});
