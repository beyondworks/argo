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
  assert.match(route, /from\('msgr_org_policies'\)\.select\('org_id, allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by'\)/, '라우트가 정책을 조회하지 않는다');
  assert.match(route, /o\.policy = /, '조직에 policy가 붙지 않는다');
  const src = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function ConnectorsCard('));
  assert.match(src, /role="radio" aria-checked=\{allow === v\} disabled=\{busy === a\.slug \|\| !!org\?\.policy\?\.allow_locked\}/, '허용 범위 라디오가 정책 잠금에 비활성화되지 않는다');
  assert.match(src, /register\(a\.slug, org\?\.policy\?\.allow_locked \? org\.policy\.allow_default : 'owner', \[\]\)/, '등록 버튼이 잠긴 기본값을 쓰지 않는다');
  assert.match(src, /org\?\.policy\?\.allow_locked && <span[^>]*>\{t\('settings\.msgr\.allow\.locked'\)\}/, '잠금 안내 문구가 없다');
  assert.match(i18n, /'settings\.msgr\.allow\.locked': \['[^']+', '[^']+'\]/, 'settings.msgr.allow.locked ko/en');
});

test('H-0: 메신저 앱 — loadOrg가 정책을 읽고, 크루 시트·채널 시트는 잠금에 비활성, 정책 카드는 관리자만 저장·비관리자는 안내', () => {
  assert.match(app, /from\('msgr_org_policies'\)\.select\('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by, approver_user_ids, crew_create, crew_runner, crew_model, guest_seats'\)/, '조직 정책 조회가 없다');
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
  assert.match(pc, /from\('msgr_org_policies'\)\.update\(\{ allow_default: draft\.allow_default, allow_locked: draft\.allow_locked, crew_memory_default: draft\.crew_memory_default, crew_memory_locked: draft\.crew_memory_locked, approval_high_by: draft\.approval_high_by, approver_user_ids: draft\.approver_user_ids \?\? \[\], crew_create: draft\.crew_create \?\? 'channel_admin', crew_runner: draft\.crew_runner\?\.trim\(\) \|\| null, crew_model: draft\.crew_model\?\.trim\(\) \|\| null, guest_seats: !!draft\.guest_seats \}\)\.eq\('org_id', org\.id\)\.select\('org_id'\)/, '정책 저장 문장');
  assert.match(pc, /if \(!res\.data\?\.length\) return onError\(t\('set\.policy\.adminOnly'\)\);/, 'RLS 0행(비관리자)을 안내로 바꾸지 않는다');
  assert.match(pc, /const ro = !isAdmin \|\| busy;/, '비관리자 읽기 전용');
  assert.match(pc, /\{isAdmin \? <div className="row"><button[^\n]*onClick=\{save\}/, '저장 버튼이 관리자에게만 있지 않다');
  assert.match(pc, /: <p className="note">\{t\('set\.policy\.adminOnly'\)\}<\/p>\}/, '비관리자 안내가 없다');
  assert.match(pc, /\{t\('set\.policy\.limit'\)\}/, '개인 PC 크루 한계 정직 표기가 없다');
  const settings = app.slice(app.indexOf('function Settings('), app.indexOf('function PolicyCard('));
  assert.match(settings, /\{policy && <PolicyCard org=\{org\} isAdmin=\{isAdmin\} policy=\{policy\}/, '설정 페이지(크루와 서버 탭)에 정책 카드가 없다');
  for (const k of ['set.policy', 'set.policy.desc', 'set.policy.allow', 'set.policy.memory', 'set.policy.lock', 'set.policy.limit', 'set.policy.saved', 'set.policy.adminOnly', 'crew.allow.locked', 'ch.memory.locked', 'err.policyLocked']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('메신저 로그아웃은 이 기기(scope local)만 — 전역이면 같은 계정의 아르고 기기 세션 리프레시 토큰까지 폐기된다(2026-09-03 실측: 격리 아르고가 revoked로 죽음)', () => {
  assert.doesNotMatch(app, /auth\.signOut\(\)/, '범위 없는 signOut()이 남아 있다');
  assert.equal((app.match(/auth\.signOut\(\{ scope: 'local' \}\)/g) ?? []).length, 2, '로그아웃 두 곳(레일 풋터·설정 계정 카드) 모두 local 범위여야 한다');
});

test('H-1: 결재 슬립은 위험 등급·정책으로 확정권을 나누고(고위험=관리자 기본), 정책 카드에 고위험 결재권 행, 브리지가 risk를 싣는다', () => {
  assert.match(app, /select\('id, crew_id, approval_id, action, reason, status, decided_by, decided_at, message_id, risk, kind, payload'\)/, '결재 조회에 risk·kind·payload가 없다');
  const slip = app.slice(app.indexOf('function Slip('), app.indexOf('function Attachment('));
  assert.match(slip, /const high = ap\.risk === 'high';/, '위험 판정');
  assert.match(slip, /const mode = policy\?\.approval_high_by \?\? 'admin';\n\s*const byAdmin = high && mode !== 'owner';/, '정책 기본값은 admin이어야 한다');
  assert.match(slip, /const can = byAdmin \? \(!!isAdmin \|\| \(mode === 'approvers' && isApprover\)\) : owner;/, '확정권 = 고위험이면 관리자(또는 지정 결재권자), 아니면 소유자');
  assert.match(slip, /\{ap\.status === 'pending' && can && \(<>/, '버튼은 확정권자에게만');
  assert.match(slip, /\{ap\.status === 'pending' && !can && <span className="note">\{byAdmin \? \(mode === 'approvers' \? t\('ap\.approverNote'\) : t\('ap\.adminNote'\)\) : t\('ap\.ownerNote'\)\}<\/span>\}/, '비권자 안내가 등급별이 아니다');
  assert.match(slip, /\{high && <span className="msgr-klabel risk">\{t\('ap\.high'\)\}<\/span>\}/, '고위험 배지가 없다');
  assert.match(app, /onError\(t\(ap\.risk === 'high' \? 'ap\.approverOnly' : 'ap\.ownerOnly'\)\)/, 'RLS 0행 문구가 등급별이 아니다');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /approval_high_by: draft\.approval_high_by, approver_user_ids: draft\.approver_user_ids \?\? \[\], crew_create: draft\.crew_create \?\? 'channel_admin', crew_runner: draft\.crew_runner\?\.trim\(\) \|\| null, crew_model: draft\.crew_model\?\.trim\(\) \|\| null, guest_seats: !!draft\.guest_seats \}\)/, '정책 저장에 approval_high_by·approver_user_ids가 없다');
  assert.match(pc, /\['admin', 'approvers', 'owner'\]\.map\(\(v\) => <button key=\{v\} type="button" role="radio" aria-checked=\{\(draft\.approval_high_by \?\? 'admin'\) === v\}/, '고위험 결재권 세그먼트');
  const bridge = stripComments(read('src/gateway/msgr.mjs'));
  assert.match(bridge, /const risk = approvalRisk\(it\);/, '브리지 위험 판정');
  assert.match(bridge, /approval_id: it\.id, action: it\.action, reason: it\.reason \?\? null, risk,\n\s*\.\.\.\(it\.kind === 'org_doc' \? \{ kind: 'org_doc', payload: it\.payload \?\? null \} : \{\}\) \}\);/, '미러 행에 risk·(org_doc이면 kind·payload)가 없다');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /'approval_id', 'action', 'created_at', 'risk'\);/, 'risk가 잠긴 컬럼이 아니다(등급 하향 가능)');
  assert.match(sql, /and decided_by = \(select auth\.uid\(\)\) and public\.msgr_can_decide\(id\)\)\);/, '확정 with check가 msgr_can_decide를 안 본다');
  for (const k of ['ap.high', 'ap.wait.admin', 'ap.adminNote', 'ap.approverOnly', 'set.policy.approval', 'set.policy.approval.admin', 'set.policy.approval.owner', 'set.policy.approval.desc']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('I-1/H-3: 크루 등급은 서비스 계정 소유 + resident만 회사 크루(서버 msgr_crew_tier와 같은 규칙), 레일 카드·시트에 등급 배지·소유 표기·한계 문장', () => {
  assert.match(app, /export const crewTier = \(crew, org\) => \(org\?\.service_user_id && crew\?\.owner_user_id === org\.service_user_id && crew\?\.hosting === 'resident'\) \? 'company' : 'personal';/, '등급 규칙이 서버 함수와 다르다');
  assert.match(app, /msgr_orgs\(id, name, slug, owner_user_id, service_user_id, node_seen_at, pending_owner_user_id, successor_user_id, auto_join_domain, auto_join_role, deleted_at, node_info\)/, '조직 조회에 service_user_id가 없다'); // I-4·J-2가 열 추가
  assert.match(app, /<Av name=\{c\.display_name\} crew size="sm" company=\{company\} \/><span className="name">\{c\.display_name\}<\/span>/, '구성 행 아바타에 회사 배지가 없다');
  assert.match(app, /\{company \? t\('crew\.tier\.company\.sub'/, '구성 행 부제가 등급별이 아니다');
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

test('I-2: 아르고 설정 카드가 조직 정책 요약(허용 범위·고위험 결재권·크루 기억·잠금)과 "파견 = 개인 크루" 한계 문장을 보이고, 라우트가 정책 3항목을 더 싣는다', () => {
  assert.match(route, /select\('org_id, allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by'\)/, '라우트 정책 조회');
  const src = page.slice(page.indexOf('function MsgrCard('), page.indexOf('function ConnectorsCard('));
  assert.match(src, /\{org\?\.policy && \(/, '정책 요약 블록');
  assert.match(src, /t\('settings\.msgr\.policy\.summary', \{ allow: [^\n]*approver: t\(`settings\.msgr\.policy\.approver\.\$\{org\.policy\.approval_high_by \?\? 'admin'\}`\)[^\n]*memory: /, '요약 문장에 세 항목이 없다');
  assert.match(src, /\{t\('settings\.msgr\.tierNote'\)\}/, '파견 = 개인 크루 한계 문장이 없다');
  for (const k of ['settings.msgr.policy', 'settings.msgr.policy.summary', 'settings.msgr.policy.locked', 'settings.msgr.policy.approver.admin', 'settings.msgr.policy.approver.owner', 'settings.msgr.policy.memory.on', 'settings.msgr.policy.memory.off', 'settings.msgr.tierNote']) {
    assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('I-3: 채널 개인 크루 정책 — 조회·시트 세그먼트(dm 제외)·차단 안내·멤버 추가 거절 문구·멘션 후보 필터, 브리지는 사유 RPC(채널 포함)로 묻고 채널 사유를 안내, 서버 게이트 3종', () => {
  assert.match(app, /select\('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids'\)/, '채널 조회에 personal_crews가 없다');
  const ch = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(ch, /\{channel\.kind !== 'dm' && \(<>\s*<div className="row wrap">\s*<span className="msgr-klabel">\{t\('ch\.personal'\)\}/, '개인 크루 정책은 채널 설정 안(dm 제외)');
  assert.match(ch, /\['allowed', 'read_only', 'blocked'\]\.map\(\(v\) => <button key=\{v\} type="button" role="radio" aria-checked=\{\(channel\.personal_crews \?\? 'allowed'\) === v\}[^\n]*disabled=\{!canEdit \|\| busy\} onClick=\{\(\) => upd\(\{ personal_crews: v \}, t\('ch\.personal\.saved'\)\)\}/, '세그먼트');
  assert.match(ch, /\/msgr_channel_personal_blocked\/\.test\(res\.error\.message\) \? t\('err\.channelPersonalBlocked'\)/, '멤버 추가 거절 문구');
  assert.match(ch, /const addableCrews = crews\.filter\(\(c\) => !crewIds\.has\(c\.id\) && \(\(channel\.personal_crews \?\? 'allowed'\) !== 'blocked' \|\| crewTier\(c, org\) === 'company'\)\);/, '차단 채널의 추가 후보에 개인 크루가 남는다(안 될 버튼)');
  const comp = app.slice(app.indexOf('function Composer('));
  assert.match(comp, /const usable = channel\?\.personal_crews && channel\.personal_crews !== 'allowed' \? crews\.filter\(\(c\) => crewTier\(c, org\) === 'company'\) : crews;/, '멘션 후보 필터');
  assert.match(comp, /const list = \[\.\.\.usable\.map\(/, '후보가 usable을 안 쓴다');
  const bridge = stripComments(read('src/gateway/msgr.mjs'));
  assert.match(bridge, /const why = await db\.instructCheck\(crew\.id, m\.author_user_id, m\.channel_id\)\.catch\(/, '브리지가 채널을 넣어 사유 RPC를 묻지 않는다');
  assert.match(bridge, /if \(why !== 'ok'\) \{/, '허용 판정 분기');
  assert.match(bridge, /body: why === 'channel_policy'\n\s*\? pick\(`이 채널은 회사 크루만 일할 수 있습니다\(채널 정책\)/, '채널 사유 안내');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /when channel is not null and ch\.personal_crews <> 'allowed'\n\s*and not \(o\.service_user_id is not null and c\.owner_user_id = o\.service_user_id and c\.hosting = 'resident'\) then 'channel_policy'/, '서버 채널 정책 판정');
  assert.match(sql, /if not public\.msgr_can_instruct\(new\.crew_id, src\.author_user_id, new\.channel_id\) then/, '답글 게이트가 채널을 안 본다');
  assert.match(sql, /raise exception 'msgr_channel_personal_blocked'/, '멤버 게이트');
  assert.match(sql, /if new\.personal_crews = 'blocked' and old\.personal_crews <> 'blocked' then\n\s*delete from public\.msgr_channel_members cm/, 'blocked 전환 sweep');
  for (const k of ['ch.personal', 'ch.personal.desc', 'ch.personal.allowed', 'ch.personal.read_only', 'ch.personal.blocked', 'ch.personal.saved', 'ch.personal.blocked.note', 'err.channelPersonalBlocked']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('G-1: 조직 문서 — 풋터 버튼·페이지 분기, 목록은 org 단위 조회, 편집권 힌트(전사=관리자·채널=멤버)와 RLS 0행 문구, 생성 경로는 폴더/슬러그.md, 서버 편집권 함수·버전 트리거·감사', () => {
  assert.doesNotMatch(app, /page === 'docs'|function Docs\(/, '별도 문서 페이지 없음 — 조직 문서(=조직의 기억)는 기억 페이지 한 곳(유건 지적 2026-09-04: 보이는 건 활동이 아니라 기억이어야)');
  const docs = app.slice(app.indexOf('function MemDoc('), app.indexOf('function Activity('));
  const actv = app.slice(app.indexOf('function Activity('), app.indexOf('/* ─── 조직 문서(G-1)'));
  assert.match(actv, /from\('msgr_org_docs'\)\.select\('id, channel_id, path, title, body, version, updated_by, updated_at'\)\.eq\('org_id', org\.id\)\.order\('path'\)/, '목록 조회(본문 포함 — 문서 탭·[[링크]] 그래프)');
  assert.match(actv, /const canNew = sel === 'org' \? isAdmin : !!ch;/, '새 기억은 전사=관리자·채널=멤버, 사람·크루 탭엔 없음');
  assert.match(actv, /<details className="msgr-actfold">/, '활동 기록은 접힌 보조 정보(주 내용은 기억)');
  assert.match(docs, /const canEdit = \(d\) => d\.channel_id \? true : isAdmin;/, '편집권 힌트');
  assert.match(docs, /if \(!res\.data\?\.length\) return onError\(t\('docs\.noEdit'\)\);/, 'RLS 0행 문구');
  assert.match(docs, /path: `\$\{creating\.folder\}\/\$\{docSlug\(title\)\}\.md`, title, body: '', created_by: uid, updated_by: uid/, '생성 경로·작성자');
  assert.match(app, /export const docSlug = \(title\) =>/, '슬러그 함수');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /select case when ch is null then public\.msgr_is_admin\(org\)\n\s*else public\.msgr_can_write_channel\(ch\) and exists/, '서버 편집권');
  assert.match(sql, /new\.version := old\.version \+ 1; new\.updated_at := now\(\);/, '버전 트리거');
  assert.match(sql, /'doc\.' \|\| lower\(tg_op\), 'doc', r\.id::text/, '문서 감사');
  assert.match(sql, /path ~ '\^\(rules\|glossary\|projects\)\//, '폴더 3종 경로 제약');
  for (const k of ['docs.title', 'docs.scope', 'docs.scope.org', 'docs.scope.channel', 'docs.folder', 'docs.folder.rules', 'docs.folder.glossary', 'docs.folder.projects', 'docs.new', 'docs.new.title', 'docs.new.placeholder', 'docs.create', 'docs.created', 'docs.dup', 'docs.edit', 'docs.saved', 'docs.noEdit', 'docs.adminOnly', 'docs.meta', 'docs.pick', 'docs.blank', 'docs.empty.all', 'docs.empty.org', 'docs.empty.channel', 'ui.cancel']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('QA(2026-09-04): 네이티브 prompt/confirm/alert 0 — 새 채널·새 조직은 인라인 폼, 보관은 2단계 확인, 첨부 오류는 토스트; 인용 말줄임 span; 크루 순서 고정; 개발용 로그인은 DEV에서만', () => {
  assert.doesNotMatch(app, /\b(prompt|confirm|alert)\(/, '네이티브 대화상자가 남아 있다(사용성·룩 불일치)');
  assert.match(app, /<form className="msgr-inline" onSubmit=\{\(e\) => \{ e\.preventDefault\(\); createChannel\(\); \}\}>/, '새 채널 인라인 폼');
  assert.match(app, /<form className="msgr-inline" onSubmit=\{\(e\) => \{ e\.preventDefault\(\); createOrg\(newOrg\); \}\}>/, '새 조직 인라인 폼');
  assert.match(app, /const \[confirmArchive, setConfirmArchive\] = useState\(false\);/, '보관 2단계 상태');
  assert.match(app, /: <div className="confirm"><p>\{t\('ch\.archive\.confirm'\)\}<\/p>/, '보관 확인 문구');
  assert.match(app, /if \(error\) return onError\?\.\(error\.message\);/, '첨부 오류 토스트');
  assert.match(app, /<span className="q">\{parent\.author_kind === 'user'/, '인용 말줄임 span');
  assert.match(app, /crs\.sort\(\(a, b\) => \(crewTier\(b, orgRow\) === 'company'\) - \(crewTier\(a, orgRow\) === 'company'\) \|\| a\.display_name\.localeCompare\(b\.display_name, 'ko'\)\);/, '크루 순서 고정');
  assert.match(app, /\{import\.meta\.env\.DEV && \(<>/, '개발용 로그인 DEV 게이트');
  const css = read('apps/messenger/src/styles.css');
  assert.match(css, /^\.msgr-quote \.q \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/m, '인용 말줄임 CSS');
  assert.match(css, /^\.switchrow \{ display: inline-flex; align-items: center; gap: 8px;/m, '체크박스 행 간격');
  assert.match(css, /^\.msgr-scrim \{ display: none; \}/m, '데스크톱에서 레일 스크림이 그리드 칸을 차지한다(레일 밀림)');
  assert.match(css, /\n  \.msgr-scrim \{ display: block; position: fixed;/, '폰 폭 스크림 표시');
  for (const k of ['ch.new.kind', 'ch.new.public', 'ch.new.private', 'ui.create', 'auth.devOnly']) assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('채널 중심 레일(유건 지시 2026-09-04): 레일엔 채널·1:1 목록만(크루 카드·멤버 스택 없음), 상단 참여 버튼이 시트를 열고, 시트의 참여 구성은 공개=조직 전원+정책 허용 크루 / 비공개=채널 멤버, 초대는 조직 메뉴', () => {
  assert.doesNotMatch(app, /msgr-crewcard|msgr-stack/, '레일에 크루 카드·멤버 스택이 남아 있다');
  assert.match(app, /<div className="msgr-list">\n\s*\{sortedCh\.map\(\(c\) => \{ const canManage/, '채널 세로 목록(행 메뉴 포함)');
  assert.match(app, /const chPeople = !channel \? \[\] : channel\.kind === 'public' \? members : members\.filter\(\(m\) => chMembers\.some\(/, '사람 구성 계산');
  assert.match(app, /const chCrews = !channel \? \[\] : channel\.kind === 'public' \? usableCrews : crews\.filter\(\(c\) => chMembers\.some\(/, '크루 구성 계산(공개=정책 허용 크루)');
  assert.match(app, /<button type="button" className="members" onClick=\{onTitle\} title=\{t\('ch\.composition'\)\}/, '상단 참여 버튼');
  assert.match(app, /onCrew=\{\(id\) => \{ setChSheet\(false\); setSheet\(id\); \}\} onDm=\{\(id\) => openDm\('user', id\)\}/, '구성에서 크루 시트·1:1 연결');
  assert.match(app, /\{isAdmin && <button type="button" role="menuitem" onClick=\{\(\) => \{ setOrgMenu\(false\); invite\(\); \}\}>/, '초대가 조직 메뉴에 없다');
  const ch = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(ch, /<div className="sec-head"><h3>\{t\('ch\.who'\)\}<\/h3>/, '구성 섹션이 첫 절');
  assert.ok(ch.indexOf("t('ch.who')") < ch.indexOf("t('ch.settings')"), '구성이 채널 설정보다 앞');
  assert.match(ch, /\{scoped && canEdit && channel\.kind !== 'dm' && <button type="button" role="menuitem" className="danger"[^\n]*removeMember\('user', m\.user_id\)/, '비공개 채널 사람 내보내기(행 … 메뉴)');
  for (const k of ['ch.composition', 'ch.composition.count', 'ch.composition.public', 'ch.composition.scoped', 'ch.people', 'ch.crews', 'ch.crews.none', 'ch.crews.none.scoped', 'ch.open.crew', 'ui.me', 'rail.hint']) assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('스크롤 QA(2026-09-04): 스레드는 바닥 고정 ref + ResizeObserver(렌더 뒤 높이 변화 추적)·위로 올려두면 유지, 채널 전환 시 바닥부터; 레일은 railbody만 스크롤(풋터 고정)', () => {
  const ch = app.slice(app.indexOf('function Channel('), app.indexOf('function Message('));
  assert.match(ch, /const stick = useRef\(true\);/, '바닥 고정 ref');
  assert.match(ch, /useEffect\(\(\) => \{ stick\.current = true; \}, \[chId\]\);/, '채널 전환 시 바닥부터');
  assert.match(ch, /stick\.current = el\.scrollHeight - el\.scrollTop - el\.clientHeight < 40;/, '바닥 근접 판정 40px');
  assert.match(ch, /const ro = new ResizeObserver\(toBottom\);/, '높이 변화 추적');
  assert.match(ch, /useEffect\(\(\) => \{ const el = feed\.current; if \(el && stick\.current\) el\.scrollTop = el\.scrollHeight; \}, \[msgs\?\.length\]\);/, '새 메시지는 고정 중일 때만 바닥');
  assert.doesNotMatch(ch, /feed\.current\?\.scrollTo\(\{ top: feed\.current\.scrollHeight \}\)/, '무조건 바닥 스크롤이 남아 있다(위로 올린 사용자를 끌어내린다)');
  assert.match(app, /<div className="msgr-railbody">\n\s*<div className="msgr-group">\{t\('ch\.list'\)\}/, '레일 본문 스크롤 영역');
  const css = read('apps/messenger/src/styles.css');
  assert.match(css, /^\.msgr-side \{[^\n]*overflow: hidden; \}/m, '레일 자체 스크롤 금지(풋터 고정)');
  assert.match(css, /^\.msgr-railbody \{ flex: 1; min-height: 0; overflow-y: auto;/m, '레일 본문만 스크롤');
  assert.match(css, /^\.msgr-sheetwrap \.msgr-crewsheet \{ z-index: 66; \}/m, '시트가 투명 스크림(z 65) 아래면 시트 위 휠이 스레드를 굴린다');
});

test('F2 조직 운영: 표시명 편집(본인 정책·가드), 관리자 조직 카드(이름·역할·제거 2단계·초대 만들기/취소·감사), 로컬 알림(멘션·관리자 결재, 자기 글 제외, 다른 채널/숨김일 때만), 오프보딩 트리거', () => {
  const dn = app.slice(app.indexOf('function DisplayNameRow('), app.indexOf('function NotifyRow('));
  assert.match(dn, /from\('msgr_org_members'\)\.update\(\{ display_name: name\.trim\(\) \|\| null \}\)\.eq\('org_id', org\.id\)\.eq\('user_id', me\.user_id\)\.select\('user_id'\)/, '본인 표시명 갱신');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(oc, /from\('msgr_orgs'\)\.update\(\{ name: name\.trim\(\) \}\)\.eq\('id', org\.id\)\.select\('id'\)/, '조직 이름');
  assert.match(oc, /const canEdit = !isMe && !isSvc && m\.role !== 'owner';/, '본인·소유자·서버 계정 행은 편집 불가');
  assert.match(oc, /\{canEdit && confirmRemove === m\.user_id && <span className="confirm-inline">/, '제거 2단계');
  assert.match(oc, /update\(\{ removed_at: new Date\(\)\.toISOString\(\) \}\)/, '제거 = removed_at(삭제 아님, 발언 유지)');
  assert.match(oc, /const makeInvite = async \(role = 'member'\) => \{[\s\S]*?insert\(\{ org_id: org\.id, role, created_by: uid \}\)/, '초대 만들기(역할 인자)');
  assert.match(oc, /from\('msgr_invites'\)\.delete\(\)\.eq\('id', inv\.id\)\.select\('id'\)/, '초대 취소');
  assert.match(oc, /from\('msgr_audit_log'\)\.select\([^)]*\)\.eq\('org_id', org\.id\)\.order\('at', \{ ascending: false \}\)\.limit\(50\)/, '감사 50건');
  assert.match(app, /const notifyMention = \(payload\) => \{[\s\S]*?if \(!payload \|\| payload\.author_user_id === r\.uid\) return;[\s\S]*?m\?\.kind === 'user' && m\.id === r\.uid/, '멘션 알림: 자기 글 제외·나를 부른 것만');
  assert.match(app, /const shouldNotify = \(channelId\) => \{ const r = notifyRef\.current; return document\.visibilityState === 'hidden' \|\| r\.page !== 'chat' \|\| r\.chId !== channelId; \};/, '보고 있는 채널은 알리지 않는다');
  assert.match(app, /if \(!payload \|\| payload\.status !== 'pending' \|\| !r\.isAdmin \|\| !shouldNotify\(payload\.channel_id\)\) return;/, '결재 알림은 관리자·대기 중만');
  assert.match(app, /Notification\.permission !== 'granted'\) return;/, '권한 없으면 조용히');
  assert.match(app, /\{tab === 'org' && org && \(isAdmin\s*\? <OrgCard part="org"/, '조직 카드는 관리자만(조직 탭)');
  assert.match(app, /\{tab === 'members' && org && \(isAdmin\s*\? <OrgCard part="members"/, '멤버 탭은 관리자 편집·멤버 읽기');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /create policy msgr_members_update_self on public\.msgr_org_members for update to authenticated\n\s*using \(user_id = \(select auth\.uid\(\)\) and removed_at is null\)/, '본인 갱신 정책');
  assert.match(sql, /raise exception 'msgr_member_self_only_name'/, '본인은 역할·제거 표시 변경 불가');
  assert.match(sql, /update public\.msgr_crews set status = 'detached' where org_id = new\.org_id and owner_user_id = new\.user_id and status = 'active';/, '오프보딩 → 크루 detach');
  assert.match(sql, /'author_user_id', new\.author_user_id, 'crew_id', new\.crew_id/, '방송 payload에 author_user_id');
  for (const k of ['set.name', 'set.name.placeholder', 'set.name.saved', 'set.name.noEdit', 'set.notify.ask', 'set.notify.on', 'set.notify.denied', 'set.notify.unsupported', 'set.org', 'set.org.desc', 'org.name.saved', 'org.noEdit', 'org.member.role', 'org.member.roleSaved', 'org.member.noEdit', 'org.member.remove', 'org.member.remove.confirm', 'org.member.removed', 'org.invites', 'org.invites.desc', 'org.invite.role', 'org.invite.make', 'org.invite.copy', 'org.invite.copied', 'org.invite.revoke', 'org.invite.revoked', 'org.invite.expires', 'org.audit', 'org.audit.load', 'org.audit.reload', 'org.audit.empty', 'org.audit.system', 'notify.mention', 'notify.approval']) {
    assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  }
});

test('J-1 역할: 채널 관리자(admin_user_ids — 편집권·지정 토글·태그, 지정은 관리자·생성자만)와 지정 결재권자(approvers 정책·피커·슬립 확정권), 서버 함수·가드', () => {
  assert.match(app, /select\('id, kind, name, topic, crew_memory, personal_crews, created_by, admin_user_ids'\)/, '채널 조회에 admin_user_ids');
  assert.match(app, /select\('allow_default, allow_locked, crew_memory_default, crew_memory_locked, approval_high_by, approver_user_ids, crew_create, crew_runner, crew_model, guest_seats'\)/, '정책 조회에 approver_user_ids');
  const ch = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(ch, /const canEdit = isAdmin \|\| channel\.created_by === uid \|\| chAdmins\.includes\(uid\);/, '채널 관리자 편집권');
  assert.match(ch, /const canAssignAdmins = \(isAdmin \|\| channel\.created_by === uid\) && channel\.kind !== 'dm';/, '지정은 조직 관리자·생성자만');
  const slip = app.slice(app.indexOf('function Slip('), app.indexOf('function Attachment('));
  assert.match(slip, /const can = byAdmin \? \(!!isAdmin \|\| \(mode === 'approvers' && isApprover\)\) : owner;/, '슬립 확정권에 지정 결재권자');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /\['admin', 'approvers', 'owner'\]\.map/, '정책 세그먼트 3옵션');
  assert.match(pc, /approver_user_ids: draft\.approver_user_ids \?\? \[\], crew_create: draft\.crew_create \?\? 'channel_admin', crew_runner: draft\.crew_runner\?\.trim\(\) \|\| null, crew_model: draft\.crew_model\?\.trim\(\) \|\| null, guest_seats: !!draft\.guest_seats \}\)/, '결재권자 저장');
  assert.match(pc, /members\.filter\(\(m\) => m\.role !== 'owner' && m\.role !== 'guest' && m\.user_id !== org\.service_user_id\)\.map/, '결재권자 후보에서 게스트·서버 계정 제외');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /c\.created_by = auth\.uid\(\) or auth\.uid\(\) = any \(c\.admin_user_ids\) or \(c\.kind <> 'dm' and coalesce\(public\.msgr_is_admin\(c\.org_id\), false\)\)/, '채널 관리 판정');
  assert.match(sql, /raise exception 'msgr_channel_admins_owner_only'/, '관리자 자기 증식 방지');
  assert.match(sql, /when coalesce\(p\.approval_high_by, 'admin'\) = 'approvers' then coalesce\(public\.msgr_is_admin\(a\.org_id\), false\) or auth\.uid\(\) = any \(coalesce\(p\.approver_user_ids, '\{\}'::uuid\[\]\)\)/, '지정 결재권자 판정');
  for (const k of ['ch.admin', 'ch.admin.creator', 'ch.admin.set', 'ch.admin.unset', 'ch.admin.saved', 'set.policy.approval.approvers', 'set.policy.approvers', 'set.policy.approvers.desc', 'ap.approverNote']) assert.match(msgrI18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
});

test('I-4 회사 노드 — 조직 행에 하트비트, 노드용 초대는 member·for_node, 노드 코드는 사람 초대 목록 제외, 다시 만들면 이전 코드 취소', () => {
  const app = read('apps/messenger/src/App.jsx');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(app, /msgr_orgs\(id, name, slug, owner_user_id, service_user_id, node_seen_at, pending_owner_user_id, successor_user_id, auto_join_domain, auto_join_role, deleted_at, node_info\)/, '조직 행에 node_seen_at');
  assert.match(oc, /insert\(\{ org_id: org\.id, role: 'member', for_node: true, created_by: uid \}\)/, '노드용 초대 = member + for_node');
  assert.match(oc, /const open = live\.filter\(\(i\) => !i\.for_node\); const nodeInvite = live\.find\(\(i\) => i\.for_node\) \?\? null;/, '노드 코드는 사람 초대 목록에서 제외');
  assert.match(oc, /const nodeAlive = !!org\.service_user_id && nodeSeen > 0 && Date\.now\(\) - nodeSeen < AWAY_MS;/, '연결됨 판정 = 서비스 계정 있음 ∧ 90초 이내 하트비트');
  assert.match(oc, /<code>\{nodeCmd\}<\/code>/, '명령 블록');
  assert.ok(!/fmtTs\(/.test(oc) && /fmtWhen\(nodeInvite\.expires_at, lang\)/.test(oc) && /fmtWhen\(org\.node_seen_at, lang\)/.test(oc), '조직 카드 시각은 날짜 포함형(fmtWhen) — 7일 뒤 만료·며칠 전 응답을 시간만으로 보이지 않게');
  assert.match(oc, /if \(nodeInvite\) \{ const d = await supabase\.from\('msgr_invites'\)\.delete\(\)\.eq\('id', nodeInvite\.id\);/, '다시 만들기 = 이전 노드 코드 취소 후 발급');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['org.node', 'org.node.none', 'org.node.never', 'org.node.on', 'org.node.off', 'org.node.make', 'org.node.remake', 'org.node.cmd', 'org.node.hint']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('I-5 회사 크루 만들기 — 정책 crew_create 세그먼트·저장, 채널 시트 권한 행렬·요청 insert 모양·노드 없음 안내, i18n', () => {
  const app = read('apps/messenger/src/App.jsx');
  assert.match(app, /approver_user_ids, crew_create, crew_runner, crew_model, guest_seats'\)\.eq\('org_id', id\)/, '정책 조회에 crew_create');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /crew_create: draft\.crew_create \?\? 'channel_admin', crew_runner: draft\.crew_runner\?\.trim\(\) \|\| null, crew_model: draft\.crew_model\?\.trim\(\) \|\| null, guest_seats: !!draft\.guest_seats \}\)\.eq\('org_id', org\.id\)/, '정책 저장에 crew_create');
  assert.match(pc, /\['admin', 'channel_admin', 'member'\]\.map\(\(v\) => <button key=\{v\} type="button" role="radio" aria-checked=\{\(draft\.crew_create \?\? 'channel_admin'\) === v\}/, '3옵션 세그먼트');
  const cs = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(cs, /const canCreateCrew = channel\.kind !== 'dm' && nodeOn && myRole !== 'guest' && \(isAdmin \|\| crewCreate === 'member' \|\| \(crewCreate === 'channel_admin' && canEdit\)\);/, '권한 행렬(서버 msgr_can_create_crew와 같은 규칙, 게스트 제외)');
  assert.match(cs, /const nodeOn = nodeSet && !!org\?\.node_seen_at && Date\.now\(\) - Date\.parse\(org\.node_seen_at\) < AWAY_MS;/, '검수 M-4: 살아 있는 노드만');
  assert.match(cs, /insert\(\{ org_id: org\.id, channel_id: newCrew\.orgWide \? null : channel\.id, name: newCrew\.name\.trim\(\), role_text: newCrew\.role\.trim\(\), prompt: newCrew\.prompt\.trim\(\), created_by: uid \}\)/, '요청 행 모양');
  assert.match(cs, /const showNewCrewItem = channel\.kind !== 'dm' && \(canCreateCrew \|\| \(isAdmin && !nodeOn\)\);/, '회사 크루 항목은 관리자에겐 서버 상태와 함께(비활성+이유)');
  assert.match(cs, /disabled=\{!canCreateCrew\} onClick=\{\(\) => \{ setAdd\('newcrew'\);/, '못 만들면 항목 비활성');
  assert.match(cs, /\{isAdmin && <label className="switchrow"><input type="checkbox" checked=\{newCrew\.orgWide\}/, '조직 전체 범위는 관리자만');
  assert.match(pc, /placeholder=\{t\('set\.policy\.crewEngine\.model'\)\} value=\{draft\.crew_model \?\? ''\} maxLength=\{120\} disabled=\{ro\}/, 'I-5b 기본 엔진 입력(관리자만)');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['set.policy.crewCreate', 'set.policy.crewCreate.admin', 'set.policy.crewCreate.channel_admin', 'set.policy.crewCreate.member', 'ch.crew.new', 'ch.crew.new.noNode', 'ch.crew.new.pending', 'ch.crew.new.failed', 'ch.crew.new.done', 'ch.crew.new.orgWide']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('J-2 소유권 제안→수락·승계·읽기 전용 — 제안·승계 대상은 관리자 칩, 당사자에게 수락/거절, 잠금은 배너+보내기 비활성, 서버 함수·가드', () => {
  const app = read('apps/messenger/src/App.jsx');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(oc, /const admins = members\.filter\(\(m\) => m\.role === 'admin' && m\.user_id !== org\.service_user_id\);/, '대상은 관리자만(서버 계정 제외)');
  assert.match(oc, /const iAmNominee = org\.pending_owner_user_id === uid;/, '당사자 판정');
  assert.match(oc, /t\('org\.transfer\.offered', \{ name: nameOfUser\(org\.owner_user_id\) \}\)/, '제안자 이름은 조직 행의 owner_user_id(실측: 미조회면 ?)');
  assert.match(oc, /onClick=\{\(\) => patchOrg\(\{ owner_user_id: uid \}, t\('org\.transfer\.accepted'\)\)\}/, '수락 = 자기로 owner 갱신(서버 트리거가 검증)');
  assert.match(oc, /patchOrg\(\{ pending_owner_user_id: transfer \}, t\('org\.transfer\.sent'/, '제안(확인 문장 뒤 넘기기)');
  assert.ok(!/successor_user_id/.test(oc), '승계 관리자 지정 UI는 자동 승계가 생기기 전까지 숨김(유건 UX 지시 2026-09-04)');
  assert.match(app, /const orgLocked = ent\?\.ls_status === 'past_due' \|\| ent\?\.ls_status === 'unpaid';/, '잠금 판정(서버 msgr_org_locked와 같은 규칙)');
  assert.match(app, /\{orgLocked && <div className="msgr-notice locked">/, '잠금 배너');
  assert.match(app, /disabled=\{busy \|\| locked \|\| !text\.trim\(\)\}/, '잠금이면 보내기 비활성');
  assert.match(app, /select\('plan, seats, ls_status'\)/, '자격 조회에 ls_status');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /coalesce\(old\.pending_owner_user_id = me, false\)\) then/, '수락 판정 NULL 방어');
  assert.match(sql, /raise exception 'msgr_transfer_needs_accept'/, '직접 이전 거절');
  assert.match(sql, /and not public\.msgr_org_locked\(c\.org_id\)/, '잠금이면 채널 쓰기 불가');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['org.owner', 'org.successor', 'org.transfer', 'org.transfer.pending', 'org.transfer.offered', 'org.transfer.accept', 'org.transfer.decline', 'org.locked', 'org.locked.admin', 'org.locked.short']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('J-3 도메인 자동 가입 — 소유자 도메인 행·저장 모양·오류 문구 분기, 메뉴·빈 화면의 가입 후보는 RPC 결과, 서버 가드·RPC', () => {
  const app = read('apps/messenger/src/App.jsx');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(oc, /patchOrg\(\{ auto_join_domain: domainOn \? null : myDomain, auto_join_role: 'member' \}/, '토글 = 내 이메일 도메인 켜고 끄기(입력 없음)');
  assert.match(oc, /msgr_domain_public.*org\.domain\.public.*msgr_domain_not_owners.*org\.domain\.notOwners/, '서버 거절 사유 → 문구');
  assert.match(app, /setJoinable\(await q\(supabase\.rpc\('msgr_joinable_orgs'\)\)\.catch\(\(\) => \[\]\)\);/, '가입 후보는 서버 RPC');
  assert.match(app, /await q\(supabase\.rpc\('msgr_join_by_domain', \{ org: o\.id \}\)\)/, '가입은 RPC로만');
  assert.match(app, /\{joinable\.map\(\(o\) => <button key=\{`j-\$\{o\.id\}`\} type="button" role="menuitem" className="join"/, '메뉴 후보');
  assert.match(app, /joinable\.length \? \[\['mark', t\('org\.step\.join'\)/, '조직 없음 화면 첫 단계');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /raise exception 'msgr_domain_not_owners'/, '소유자 도메인 검증');
  assert.match(sql, /raise exception 'msgr_domain_public'/, '공개 도메인 거절');
  assert.match(sql, /and not exists \(select 1 from public\.msgr_org_members m where m\.org_id = o\.id and m\.user_id = auth\.uid\(\) and m\.removed_at is null\)/, '후보는 미가입자만');
  assert.ok(!/'example\.test'/.test(sql), '로컬 시드 도메인은 공개 목록에 없다');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['org.domain', 'org.domain.ph', 'org.domain.desc', 'org.domain.on', 'org.domain.public', 'org.domain.notOwners', 'org.join.cta', 'org.step.join']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('J-4 게스트 — 비공개 채널 시트의 게스트 링크(기간 세그먼트·채널 한정 insert), 멤버 목록 만료 표기, 정책 guest_seats, 서버 판정·좌석·수락', () => {
  const app = read('apps/messenger/src/App.jsx');
  const cs = app.slice(app.indexOf('function ChannelSheet('), app.indexOf('function Settings('));
  assert.match(cs, /insert\(\{ org_id: org\.id, role: 'guest', channel_id: channel\.id, guest_days: guestDays, created_by: uid \}\)/, '게스트 링크 insert 모양');
  assert.match(cs, /const canGuest = channel\.kind === 'private' && canEdit;/, '게스트 링크는 비공개 채널 관리자만');
  assert.match(cs, /\{add === 'guest' && \(/, '게스트 링크는 추가 메뉴 안');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(oc, /t\('org\.guest\.until', \{ when: fmtWhen\(m\.expires_at, lang\) \}\)/, '만료 표기');
  assert.match(app, /select\('user_id, role, display_name, expires_at'\)/, '멤버 조회에 expires_at');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /and \(m\.expires_at is null or m\.expires_at > now\(\)\)\n\$\$;/, 'msgr_role이 만료를 본다');
  assert.match(sql, /if new\.role = 'guest' and not gseats then return new; end if;/, '게스트 좌석 미차지(정책 off)');
  assert.match(sql, /check \(channel_id is null or role = 'guest'\)/, '채널 한정 초대 = 게스트');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['ch.guest', 'ch.guest.link', 'ch.guest.made', 'org.guest.until', 'org.guest.expired', 'set.policy.guests', 'set.policy.guests.seats']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('J-5 조직 삭제 유예·복구 — 이름 입력 2단계 삭제(네이티브 confirm 없음), 복구는 RPC, 삭제 예정 목록은 메뉴·빈 화면, 서버 트리거·RPC·purge 권한', () => {
  const app = read('apps/messenger/src/App.jsx');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.match(oc, /disabled=\{busy \|\| delName\.trim\(\) !== org\.name\} onClick=\{deleteOrg\}/, '이름이 정확히 같아야 삭제 버튼 활성');
  assert.match(oc, /update\(\{ deleted_at: new Date\(\)\.toISOString\(\) \}\)\.eq\('id', org\.id\)/, '삭제 = deleted_at 표시(서버 트리거가 소유자 판정)');
  assert.ok(!/window\.confirm|window\.prompt|confirm\(/.test(oc), '네이티브 대화상자 없음');
  assert.match(app, /await q\(supabase\.rpc\('msgr_restore_org', \{ org: o\.id \}\)\)/, '복구는 RPC');
  assert.match(app, /setDeletedOrgs\(await q\(supabase\.rpc\('msgr_my_deleted_orgs'\)\)\.catch\(\(\) => \[\]\)\);/, '삭제 예정 목록은 RPC');
  assert.match(app, /deletedOrgs\.length \? \[\['', t\('org\.step\.restore'\)/, '빈 화면 복구 단계');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /if me is not null and new\.deleted_at is distinct from old\.deleted_at and old\.owner_user_id <> me then raise exception 'msgr_owner_only'; end if;/, '삭제·복구는 소유자 계정 기준');
  assert.match(sql, /if o\.deleted_at < now\(\) - interval '30 days' then raise exception 'msgr_restore_expired'; end if;/, '30일 유예');
  assert.match(sql, /revoke execute on function public\.msgr_purge_orgs\(\) from anon, authenticated;/, 'purge는 service_role만');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['org.delete', 'org.delete.typeName', 'org.delete.confirm', 'org.delete.desc', 'org.restore.cta', 'org.restore.expired', 'org.step.restore']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('검수 반영(코드) — 삭제 조직 목록 제외, 오류 문구 매핑, 조직 전체 초대는 게스트 제외, 카드 값 개행 세척, 서버 가드', () => {
  const app = read('apps/messenger/src/App.jsx');
  assert.match(app, /rows\.filter\(\(r\) => r\.msgr_orgs && !r\.msgr_orgs\.deleted_at\)/, 'M-3');
  assert.match(app, /const friendlyErr = \(msg, t\) => \/row-level security\/\.test\(msg\) \? t\('err\.denied'\)/, 'M-5 매핑');
  assert.ok((app.match(/onError\(friendlyErr\(res\.error\.message, t\)\)/g) || []).length >= 4, 'M-5 적용 4곳 이상');
  assert.match(app, /onClick=\{\(\) => makeInvite\('admin'\)\}/, 'L-3 초대는 멤버·관리자 두 버튼');
  assert.ok(!/makeInvite\('guest'\)/.test(app), 'L-3 조직 전체 게스트 초대 없음');
  assert.ok(!/&& false\)\}/.test(app), 'L-5 죽은 조건 제거');
  const persona = read('src/persona.mjs');
  assert.match(persona, /const line = \(v\) => String\(v \?\? ''\)\.replace\(\/\[\\r\\n\]\+\/g, ' '\)\.trim\(\);/, 'H-2 세척');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /revoke execute on function public\.msgr_email_domain\(uuid\) from anon, authenticated;/, 'H-1');
  assert.match(sql, /or new\.expires_at is distinct from old\.expires_at\) then/, 'C-1');
  assert.match(sql, /raise exception 'msgr_removed_rejoin'/, 'H-4');
  assert.match(sql, /coalesce\(current_setting\('msgr\.node_accept', true\), ''\) <> '1' then raise exception 'msgr_owner_only'/, 'H-6');
  assert.match(sql, /msgr_lock_cols\('org_id', 'channel_id', 'name', 'role_text', 'prompt', 'created_by', 'created_at'\)/, 'CRITICAL-1 잠금');
  assert.match(sql, /and public\.msgr_channel_member_ok\(channel_id, member_kind, member_id\)\)/, 'HIGH-1');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['ch.crew.new.nodeOff', 'ch.crew.new.pendingOff', 'err.denied', 'err.invalid']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('UX 3/3 회사 크루 AI 드롭다운 — 서버 목록(node_info)이 있으면 select, 없으면 텍스트, 러너 바꾸면 모델 초기화, 서버 RPC 2인자', () => {
  const app = read('apps/messenger/src/App.jsx');
  const pc = app.slice(app.indexOf('function PolicyCard('), app.indexOf('function EmptyOrg('));
  assert.match(pc, /const nodeRunners = Array\.isArray\(org\?\.node_info\?\.runners\) \? org\.node_info\.runners : \[\];/, '목록은 조직 행의 node_info');
  assert.match(pc, /onChange=\{\(e\) => set\(\{ crew_runner: e\.target\.value \|\| null, crew_model: null \}\)\}/, '러너 바꾸면 모델 초기화');
  assert.match(pc, /\{nodeRunners\.length \? \(<>[\s\S]*?<select[\s\S]*?<\/>\) : \(<>[\s\S]*?<input className="msgr-input inline" placeholder=\{t\('set\.policy\.crewEngine\.runner'\)\}/, '목록 없으면 텍스트 입력');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  assert.match(sql, /create or replace function public\.msgr_node_heartbeat\(org uuid, info jsonb default null\)/, 'RPC 2인자');
  assert.match(sql, /node_info = coalesce\(info, node_info\)/, '정보 없는 하트비트는 목록 유지');
  const bridge = read('src/gateway/msgr.mjs');
  assert.match(bridge, /await db\.nodeHeartbeat\(nodeOrgId, await runnerInfo\(wsId\)\.catch\(\(\) => null\)\)/, '하트비트에 러너 목록');
});

test('레일 행 메뉴(유건 지적 2026-09-04) — 채널 설정·나가기(내 크루 있으면 차단)·보관(관리 권한만), 1:1 나가기, 게스트 행 세그먼트 오른쪽, 게스트 링크 라벨', () => {
  const app = read('apps/messenger/src/App.jsx');
  assert.match(app, /const leaveChannel = async \(c\) => \{[\s\S]*?if \(stuck\.length\) return setErr\(t\('ch\.leave\.blocked'\)\);[\s\S]*?\.delete\(\)\.eq\('channel_id', c\.id\)\.eq\('member_kind', 'user'\)\.eq\('member_id', uid\)/, '나가기 = 내 멤버 행 삭제, 내 크루가 있으면 차단');
  assert.match(app, /\{canManage && \(railConfirm === `archive:\$\{c\.id\}`/, '보관은 관리 권한만, 2단계');
  assert.match(app, /\{c\.kind === 'private' && \(railConfirm === `leave:\$\{c\.id\}`/, '나가기는 비공개 채널만(공개는 전원 자동)');
  const oc = app.slice(app.indexOf('function OrgCard('), app.indexOf('function PolicyCard('));
  assert.ok(oc.indexOf("t('org.guest.until'") < oc.indexOf('<div className="msgr-seg right"'), '게스트 만료 문구는 세그먼트보다 앞(세그먼트 오른쪽 고정)');
  const dict = read('apps/messenger/src/i18n.js');
  for (const k of ['org.invite.kind.guest', 'ch.leave', 'ch.leave.blocked', 'ch.archive.confirm.short', 'dm.leave', 'ch.menu.settings']) assert.ok(dict.includes(`'${k}':`), `i18n ${k}`);
});

test('활동 페이지(유건 지시 2026-09-04) — 트리(조직→채널→크루·문서/사람/크루/전사 문서)+아르고 기억 그래프(별칭)+문장 목록, 감사 19종 문장 사전, 한국어 조사, 설정의 기록 탭 제거', () => {
  const app = read('apps/messenger/src/App.jsx');
  assert.match(app, /import \{ Graph3D \} from '\.\/graph3d\.jsx';/, '활동 그래프는 3D 컴포넌트(구성은 아르고 코어 재사용)');
  assert.match(app, /\{page === 'activity' && org \? \(\n\s*<Activity /, '활동 페이지 분기');
  assert.match(app, /<Graph3D key="all" docs=\{gdocs\} hint=\{t\('act\.graph\.hint'\)\} onSelectDoc=/, '그래프 탭: 3D 활동 그래프(조직 관계 문서)');
  assert.match(app, /<Graph3D key=\{sel\} docs=\{gdocs\} compact focusRel=/, '대상 탭: 집중 노드 3D 로컬 그래프');
  assert.doesNotMatch(app, /Graph2D/, '메신저 활동 페이지는 2D 그래프를 쓰지 않는다');
  const g3 = read('apps/messenger/src/graph3d.jsx');
  assert.match(g3, /import \{ buildGraph2D, stem \} from '@argo\/graph2d-core';/, '3D 그래프 구성은 아르고 코어 재사용(사본 금지)');
  assert.match(g3, /prefers-reduced-motion: reduce/, '자동 회전은 동작 축소 설정을 존중');
  assert.match(g3, /rgbVar\('--graph-rgb', null\)/, '3D 그래프도 --graph-rgb 우선');
  assert.match(g3, /canvas\.addEventListener\('wheel', onWheel, \{ passive: false \}\)/, '휠 줌은 페이지 스크롤을 막는다');
  assert.match(app, /const openTab = \(tab, \{ split = false \} = \{\}\) => \{/, '가로 다중 탭(창·분할 계약 = 기억 페이지 openTab과 같은 서명)');
  assert.match(app, /className="vault-tab-x" onClick=\{\(e\) => \{ e\.stopPropagation\(\); closeTab\(pane\.id, tb\.id\); \}\}/, '탭 닫기(창 단위)');
  assert.match(app, /^function ActRow\(\{ c, id, label, sub, depth = 0, kids = null, icon = null \}\) \{/m, '트리 행은 모듈 수준 컴포넌트(안에서 정의하면 클릭마다 리마운트)');
  assert.doesNotMatch(app.slice(app.indexOf('function Activity(')), /const Row = \(/, 'Activity 안에 행 컴포넌트를 정의하지 않는다');
  assert.match(app, /const chKey = channels\.map\(\(c\) => c\.id\)\.join\(','\);\n\s*const load = useCallback\(/, '재조회는 채널 id 목록 키(배열 정체 아님) + 저장 뒤 재사용');
  assert.match(app, /onAuxClick=\{\(e\) => \{ if \(e\.button === 1\) \{ e\.preventDefault\(\); closeTab\(pane\.id, tb\.id\); \} \}\}/, '가운데 클릭 닫기(창 단위)');
  assert.match(app, /const closeAll = \(paneId\) => keepIn\(paneId, \(\) => false\);/, '모두 닫기(창 단위)');
  assert.match(app, /onSelectDoc=\{\(rel\) => openEntity\(relOfDoc\(rel\), \{ split: true \}\)\}/, '그래프 노드 클릭 = 옆 창에 열기(아르고 기억 페이지와 같은 모양)');
  assert.match(app, /const MAX_PANES = 2;/, '창은 둘까지');
  const g2 = read('app/c/[ws]/graph2d.jsx');
  assert.match(g2, /nodeShape = 'star'/, '아르고 기억 그래프 기본은 별(변경 없음)');
  assert.match(g2, /chroma\(st\.getPropertyValue\('--graph-rgb'\)\.trim\(\)\) \?\? chroma\(st\.getPropertyValue\('--mark-rgb'\)\.trim\(\)\)/, '--graph-rgb 최우선, 없으면 --mark-rgb');
  const css = read('apps/messenger/src/styles.css');
  assert.match(css, /:root\[data-theme='linen'\], :root\[data-theme='linen-light'\] \{ --graph-rgb: 176, 82, 30; \}/, '메신저 linen 그래프 포인트색 러스트');
  assert.match(g2, /if \(shapeRef\.current === 'circle'\) \{ plain\.moveTo/, '원형 노드 분기(의존 배열 밖 ref)');
  assert.ok(!/\['audit', 'set\.tab\.audit'\]/.test(app), '설정의 기록 탭 제거');
  assert.match(app, /return lang === 'en' \? out : koJosa\(out\);/, '한국어 조사 처리');
  const dict = read('apps/messenger/src/i18n.js');
  const sql = read('supabase/migrations/20260903120000_msgr.sql');
  const actions = new Set([...sql.matchAll(/msgr_audit\([^,]*, '([a-z_.]+)'/g)].map((m) => m[1]));
  for (const a of actions) if (!a.endsWith('.')) assert.ok(dict.includes(`'act.${a}':`), `문장 사전 act.${a}`); // 'approval.'·'doc.'은 서버가 상태·연산을 이어 붙이는 접두 — 아래 완성형으로 확인
  for (const a of ['approval.approved', 'approval.rejected', 'doc.insert', 'doc.update', 'doc.delete', 'channel.admins.none']) assert.ok(dict.includes(`'act.${a}':`), `문장 사전 act.${a}`);
  const vite = read('apps/messenger/vite.config.js');
  assert.match(vite, /'@argo\/graph2d': shared\('app\/c\/\[ws\]\/graph2d\.jsx'\)/, '그래프 별칭');
});
