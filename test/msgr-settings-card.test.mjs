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
const app = stripComments(read('apps/messenger/src/App.jsx'));
const msgrI18n = read('apps/messenger/src/i18n.js');

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
  const keys = new Set([...src.matchAll(/t\('([A-Za-z0-9._-]+)'\)/g)].map((m) => m[1])); // 대소문자 — noCrews·notSignedIn 같은 키를 놓치던 수집기(검수 LOW-1)
  for (const v of ['all', 'list', 'owner']) keys.add(`settings.msgr.allow.${v}`);
  for (const r of ['owner', 'admin', 'member', 'guest']) keys.add(`role.${r}`);
  assert.ok(keys.size >= 18, `키 수집이 너무 적다(${keys.size})`);
  for (const k of keys) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} 라벨이 ko·en 둘 다 있어야 한다`);
});

// ── 메신저 앱 구간 불변식(검수 2R MEDIUM-1: 수정이 핀 없이 들어갔다) ──
test('채널 시트 닫기 효과의 의존성은 [chId]뿐 — tick이 섞이면 15초마다 시트가 닫힌다(HIGH-1 재발 방지)', () => {
  const app = stripComments(read('apps/messenger/src/App.jsx'));
  assert.match(app, /useEffect\(\(\) => \{ setChSheet\(false\); \}, \[chId\]\);/, '닫기 효과가 [chId] 단독 의존이 아니다');
  const reload = /useEffect\(\(\) => \{ loadChMembers\(chId\)[^\n]*\}, \[chId, loadChMembers, tick\]\);/.exec(app);
  assert.ok(reload && !/setChSheet/.test(reload[0]), '멤버 재조회 효과 안에 setChSheet가 있다 — tick마다 시트가 닫힌다');
});

// ── H-0 조직 정책: 잠긴 허용 범위는 카드·시트에서 선택 불가 + 정책 안내, 정책 카드는 관리자만 저장 ──
test('H-0: 라우트가 조직별 policy를 싣고, 카드는 잠금이면 라디오를 끄고 안내를 보인다', () => {
  assert.match(route, /from\('msgr_org_policies'\)\.select\('org_id, allow_default, allow_locked'\)/, '라우트가 정책을 조회하지 않는다');
  assert.match(route, /o\.policy = /, '조직에 policy가 붙지 않는다');
  const src = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function ConnectorsCard('));
  assert.match(src, /role="radio" aria-checked=\{allow === v\} disabled=\{busy === a\.slug \|\| !!org\?\.policy\?\.allow_locked\}/, '허용 범위 라디오가 정책 잠금에 비활성화되지 않는다');
  assert.match(src, /register\(a\.slug, org\?\.policy\?\.allow_locked \? org\.policy\.allow_default : 'owner', \[\]\)/, '등록 버튼이 잠긴 기본값을 쓰지 않는다');
  assert.match(src, /org\?\.policy\?\.allow_locked && <span[^>]*>\{t\('settings\.msgr\.allow\.locked'\)\}/, '잠금 안내 문구가 없다');
  assert.match(i18n, /'settings\.msgr\.allow\.locked': \['[^']+', '[^']+'\]/, 'settings.msgr.allow.locked ko/en');
});

test('H-0: 메신저 앱 — loadOrg가 정책을 읽고, 크루 시트·채널 시트는 잠금에 비활성, 정책 카드는 관리자만 저장·비관리자는 안내', () => {
  assert.match(app, /from\('msgr_org_policies'\)\.select\('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by'\)/, '조직 정책 조회가 없다');
  assert.match(app, /setEnt\(e\); setPolicy\(pol\);/, '정책이 상태에 실리지 않는다');
  const crew = app.slice(app.indexOf('function CrewSheet('), app.indexOf('function ChannelSheet('));
  assert.match(crew, /const locked = !!policy\?\.allow_locked;/, '크루 시트 잠금 판정');
  assert.match(crew, /disabled=\{!owner \|\| busy \|\| locked\} onClick=\{\(\) => pickAllow\(v\)\}/, '허용 범위 세그먼트가 잠금에 비활성화되지 않는다');
  assert.match(crew, /locked \? <p className="note">\{t\('crew\.allow\.locked'\)\}<\/p>/, '잠금 안내가 없다');
  assert.match(crew, /\/msgr_policy_locked\/\.test\(res\.error\.message\) \? t\('err\.policyLocked'\)/, '서버 거절이 정직한 문구로 안 바뀐다');
  const ch = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(ch, /const memLocked = !!policy\?\.crew_memory_locked;/, '채널 시트 잠금 판정');
  assert.match(ch, /checked=\{channel\.crew_memory !== false\} disabled=\{!canEdit \|\| busy \|\| memLocked\}/, '기억 스위치가 잠금에 비활성화되지 않는다');
  assert.match(ch, /memLocked && <p className="note">\{t\('ch\.memory\.locked'\)\}<\/p>/, '기억 잠금 안내가 없다');
  assert.match(ch, /\/msgr_policy_locked\/\.test\(res\.error\.message\) \? t\('err\.policyLocked'\)/, '채널 서버 거절 문구');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /from\('msgr_org_policies'\)\.update\(\{ allow_default: draft\.allow_default, allow_locked: draft\.allow_locked, crew_memory_default: draft\.crew_memory_default, crew_memory_locked: draft\.crew_memory_locked, approval_high_by: draft\.approval_high_by \}\)\.eq\('org_id', org\.id\)\.select\('org_id'\)/, '정책 저장 문장');
  assert.match(pc, /if \(!res\.data\?\.length\) return onError\(t\('set\.policy\.adminOnly'\)\);/, 'RLS 0행(비관리자)을 안내로 바꾸지 않는다');
  assert.match(pc, /const ro = !isAdmin \|\| busy;/, '비관리자 읽기 전용');
  assert.match(pc, /\{isAdmin \? <div className="row"><button[^\n]*onClick=\{save\}/, '저장 버튼이 관리자에게만 있지 않다');
  assert.match(pc, /: <p className="note">\{t\('set\.policy\.adminOnly'\)\}<\/p>\}/, '비관리자 안내가 없다');
  assert.match(pc, /\{t\('set\.policy\.limit'\)\}/, '개인 PC 크루 한계 정직 표기가 없다');
  const settings = app.slice(app.indexOf('function Settings('), app.indexOf('function PolicyCard('));
  assert.match(settings, /\{org && policy && <PolicyCard org=\{org\} isAdmin=\{isAdmin\} policy=\{policy\}/, '설정 페이지에 정책 카드가 없다');
  for (const k of ['set.policy', 'set.policy.desc', 'set.policy.allow', 'set.policy.memory', 'set.policy.lock', 'set.policy.limit', 'set.policy.saved', 'set.policy.adminOnly', 'crew.allow.locked', 'ch.memory.locked', 'err.policyLocked']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('메신저 로그아웃은 이 기기(scope local)만 — 전역이면 같은 계정의 아르고 기기 세션 리프레시 토큰까지 폐기된다(2026-09-03 실측: 격리 아르고가 revoked로 죽음)', () => {
  assert.doesNotMatch(app, /auth\.signOut\(\)/, '범위 없는 signOut()이 남아 있다');
  assert.equal((app.match(/auth\.signOut\(\{ scope: 'local' \}\)/g) ?? []).length, 2, '로그아웃 두 곳(레일 풋터·설정 계정 카드) 모두 local 범위여야 한다');
});

test('H-1: 결재 슬립은 위험 등급·정책으로 확정권을 나누고(고위험=관리자 기본), 정책 카드에 고위험 결재권 행, 브리지가 risk를 싣는다', () => {
  assert.match(app, /select\('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk'\)/, '결재 조회에 risk가 없다');
  const slip = app.slice(app.indexOf('function Slip('), app.indexOf('function Attachment('));
  assert.match(slip, /const high = ap\.risk === 'high';/, '위험 판정');
  assert.match(slip, /const byAdmin = high && \(policy\?\.approval_high_by \?\? 'admin'\) !== 'owner';/, '정책 기본값은 admin이어야 한다');
  assert.match(slip, /const can = byAdmin \? !!isAdmin : owner;/, '확정권 = 고위험이면 관리자, 아니면 소유자');
  assert.match(slip, /\{ap\.status === 'pending' && can && \(<>/, '버튼은 확정권자에게만');
  assert.match(slip, /\{ap\.status === 'pending' && !can && <span className="note">\{byAdmin \? t\('ap\.adminNote'\) : t\('ap\.ownerNote'\)\}<\/span>\}/, '비권자 안내가 등급별이 아니다');
  assert.match(slip, /\{high && <span className="msgr-klabel risk">\{t\('ap\.high'\)\}<\/span>\}/, '고위험 배지가 없다');
  assert.match(app, /onError\(t\(ap\.risk === 'high' \? 'ap\.approverOnly' : 'ap\.ownerOnly'\)\)/, 'RLS 0행 문구가 등급별이 아니다');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /approval_high_by: draft\.approval_high_by \}\)/, '정책 저장에 approval_high_by가 없다');
  assert.match(pc, /\['admin', 'owner'\]\.map\(\(v\) => <button key=\{v\} type="button" role="radio" aria-checked=\{\(draft\.approval_high_by \?\? 'admin'\) === v\}/, '고위험 결재권 세그먼트');
  const bridge = stripComments(read('src/gateway/msgr.mjs'));
  assert.match(bridge, /const risk = approvalRisk\(it\);/, '브리지 위험 판정');
  assert.match(bridge, /approval_id: it\.id, action: it\.action, reason: it\.reason \?\? null, risk \}\);/, '미러 행에 risk가 없다');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /'approval_id', 'action', 'created_at', 'risk'\);/, 'risk가 잠긴 컬럼이 아니다(등급 하향 가능)');
  assert.match(sql, /and decided_by = \(select auth\.uid\(\)\) and public\.msgr_can_decide\(id\)\)\);/, '확정 with check가 msgr_can_decide를 안 본다');
  for (const k of ['ap.high', 'ap.wait.admin', 'ap.adminNote', 'ap.approverOnly', 'set.policy.approval', 'set.policy.approval.admin', 'set.policy.approval.owner', 'set.policy.approval.desc']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('I-1/H-3: 크루 등급은 서비스 계정 소유 + resident만 회사 크루(서버 msgr_crew_tier와 같은 규칙), 레일 카드·시트에 등급 배지·소유 표기·한계 문장', () => {
  assert.match(app, /export const crewTier = \(crew, org\) => \(org\?\.service_user_id && crew\?\.owner_user_id === org\.service_user_id && crew\?\.hosting === 'resident'\) \? 'company' : 'personal';/, '등급 규칙이 서버 함수와 다르다');
  assert.match(app, /msgr_orgs\(id, name, slug, service_user_id\)/, '조직 조회에 service_user_id가 없다');
  assert.match(app, /<Av name=\{c\.display_name\} crew size="lg" company=\{crewTier\(c, org\) === 'company'\} \/>/, '레일 카드 아바타에 회사 배지가 없다');
  assert.match(app, /crewTier\(c, org\) === 'company' \? t\('crew\.tier\.company\.sub'/, '레일 카드 부제가 등급별이 아니다');
  const crewSheet = app.slice(app.indexOf('function CrewSheet('), app.indexOf('function ChannelSheet('));
  assert.match(crewSheet, /const tier = crewTier\(crew, org\);/, '시트 등급 판정');
  assert.match(crewSheet, /<span className=\{`msgr-tier \$\{tier\}`\}>\{tier === 'company' \? t\('crew\.tier\.company'\) : t\('crew\.tier\.personal'\)\}<\/span>/, '등급 배지');
  assert.match(crewSheet, /<p className="note tier">\{tier === 'company' \? t\('crew\.tier\.company\.note', \{ org: org\?\.name \?\? '' \}\) : t\('crew\.tier\.personal\.note', \{ name: nameOfUser\(crew\.owner_user_id\) \}\)\}<\/p>/, '한계 문장이 없다(부록 K ③)');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /c\.owner_user_id = o\.service_user_id and c\.hosting = 'resident' then 'company' else 'personal'/, '서버 판정 규칙');
  assert.match(sql, /raise exception 'msgr_service_not_member'/, '서비스 계정 멤버 검사');
  for (const k of ['crew.tier', 'crew.tier.company', 'crew.tier.personal', 'crew.tier.company.owner', 'crew.tier.company.sub', 'crew.tier.personal.sub', 'crew.tier.company.note', 'crew.tier.personal.note']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});
