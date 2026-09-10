// 부록 N-3 — 메신저 설정 "외부 에이전트" 카드·봇 표기. JSX는 소스 구간 핀으로 잠근다(코드 검수 관례). 서버 판정은 test/msgr-bots-pg.test.mjs, 라우트는 msgr-bot-facade.
import test from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../apps/messenger/src/i18n.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx');
const i18n = read('apps/messenger/src/i18n.js');
const KEYS = ['crew.hosting.bot', 'org.agents', 'org.agents.desc', 'org.agents.none', 'org.agents.add.hermes', 'org.agents.add.openclaw', 'org.agents.add.custom', 'org.agents.kind.hermes', 'org.agents.kind.openclaw', 'org.agents.kind.custom', 'org.agents.waiting', 'org.agents.on', 'org.agents.off', 'org.agents.by', 'org.agents.made', 'org.agents.rotated', 'org.agents.setup.h', 'org.agents.copy', 'org.agents.copied', 'org.agents.setup.hint', 'org.agents.rotate', 'org.agents.revoke', 'org.agents.revoke.confirm', 'org.agents.revoke.done', 'org.agents.setup.hermes.1', 'org.agents.setup.hermes.2', 'org.agents.setup.hermes.3', 'org.agents.setup.openclaw.1', 'org.agents.setup.openclaw.2', 'org.agents.setup.openclaw.3', 'org.agents.setup.custom.1', 'org.agents.setup.custom.2', 'org.agents.setup.custom.3', 'org.agents.auto.running', 'org.agents.auto.done', 'org.agents.auto.after', 'org.agents.auto.failed', 'org.agents.auto.missing', 'org.agents.auto.retry', 'org.agents.auto.step.plugin', 'org.agents.auto.step.env', 'org.agents.auto.step.enable', 'org.agents.auto.step.gateway', 'org.agents.setup.manual', 'org.agents.reconnect', 'org.agents.reconnect.title', 'org.agents.another', 'org.agents.name.mine', 'org.agents.name.other', 'org.agents.made.n', 'org.agents.auto.done.n'];

test('카드가 쓰는 i18n 키는 전부 ko/en 쌍 · 상태 문구는 "헤르메스 에이전트 연결중/연결됨/응답 없음"(유건 지정 표기)', () => {
  for (const k of KEYS) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  assert.equal(t('org.agents.waiting', 'ko', { kind: t('org.agents.kind.hermes', 'ko') }), '헤르메스 에이전트 연결중 · 아직 접속 없음');
  assert.equal(t('org.agents.on', 'ko', { kind: t('org.agents.kind.openclaw', 'ko'), when: '10:00' }), '오픈클로 에이전트 연결됨 · 10:00');
  assert.equal(t('org.agents.off', 'ko', { kind: '헤르메스', when: '10:00' }), '헤르메스 에이전트 응답 없음 · 마지막 10:00');
  assert.doesNotMatch(i18n.slice(i18n.indexOf("'org.agents'"), i18n.indexOf("'org.node.hint'")), /HTTP/, '유건 지시: 화면 표기에 HTTP 같은 기술 용어 금지');
});

test('봇 = 회사 등급(클라이언트 crewTier) · 내 에이전트 레일에 출처와 함께 포함 · 시트 hosting 표기 · 설정 크루 탭에 카드', () => {
  assert.match(app, /export const crewTier = \(crew, org\) => \(crew\?\.hosting === 'bot' \|\| /, '봇 회사 등급');
  assert.match(app, /const myCrews = sortCrews\(crews\.filter\(\(c\) => c\.owner_user_id === uid\)\);/, '내 에이전트 = 아르고 + 내가 연결한 봇(세 출처 한 목록) + 정렬(소속별·이름순·추가순)');
  assert.doesNotMatch(app, /const folders = \[\.\.\.new Set\(myCrews\.map\(\(c\) => c\.folder\)/, '그룹(폴더) 묶음은 뺐다(유건 결정 2026-09-09: 평평한 목록)');
  assert.match(app, /<button type="button" className=\{`msgr-sortbtn\$\{sortMenu \? ' on' : ''\}`\}/, '정렬 아이콘 버튼 → 메뉴(유건 지시)');
  assert.match(app, /<button type="button" className="me" onClick=\{\(\) => \{ if \(isPhone\) \{ setSettingsTab\('me'\); setPage\('settings'\)[\s\S]*?\} else setMeMenu\(\(v\) => !v\); \}\}/, '프로필 클릭: 데스크톱은 메뉴(로그아웃은 여기), 폰은 바로 설정(유건 2026-09-10)');
  assert.doesNotMatch(app, /className="btn ghost" onClick=\{\(\) => supabase\.auth\.signOut/, '하단 바의 로그아웃 아이콘 버튼 제거');
  assert.match(app, /placeholder=\{t\('org\.members\.search'\)\}/, '멤버 검색'); assert.match(app, /shown\.slice\(0, memberN\)/, '멤버 30명씩');
  assert.match(read('apps/messenger/src/styles.css'), /:root\[data-theme='linen-dark'\] \{ --primary: #cfcac0;/, '다크 순백 완화');
  assert.match(app, /const sourceOf = \(c\) => c\.hosting !== 'bot' \? 'argo' : \(botKinds\.find/, '출처 판정');
  assert.match(app, /\{railExt\.length > 0 && <div className="msgr-folder"><div className="msgr-folderhead"><span className="lbl">\{t\('rail\.src\.custom'\)\}/, '외부 에이전트가 있을 때만 소제목');
  for (const k of ['rail.src.argo', 'rail.src.hermes', 'rail.src.openclaw', 'rail.src.custom']) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  assert.match(read('apps/messenger/src/styles.css'), /\.msgr-node-cmd code \{[^}]*white-space: pre-wrap;/, '설정 두 줄이 줄바꿈으로 보인다(실측: 한 줄로 붙어 보였다)');
  assert.match(app, /crew\.hosting === 'resident' \? 'resident' : crew\.hosting === 'bot' \? 'bot' : 'local'/, '시트 hosting 표기');
  assert.match(app, /<OrgCard part="node"[^\n]*\n\s*\{isAdmin && <OrgCard part="agents"/, '크루 탭에서 노드 카드 다음에 에이전트 카드(관리자만)');
});

test('카드: 생성·회전은 RPC(토큰은 응답에서 setup 상태로만) · 설정 두 줄 = URL+토큰 · 해제는 인라인 확인 · 표는 폐기 제외', () => {
  const card = app.slice(app.indexOf('// ── 부록 N: 외부 에이전트'), app.indexOf("if (part === 'node') return ("));
  assert.match(card, /supabase\.rpc\('msgr_bot_create', \{ org: org\.id, kind, name, external_id: extId \?\? null \}\)/, '봇에 원본 에이전트 id');
  assert.match(card, /const cur = extId \? botOf\(kind, extId\) : null;\n\s*if \(cur\) \{ const r = await supabase\.rpc\('msgr_bot_rotate'/, '같은 에이전트의 봇이 있으면 회전(중복 없음)');
  assert.match(card, /await invoke\('agent_list', \{ kind \}\)/, '이 컴퓨터의 에이전트 전원 읽기');
  assert.match(card, /for \(const a of agents\) made\.push\(\{ \.\.\.\(await mkOrRotate\(kind, a\.name, externalAgentId\(installation, uid, kind, a\.id\)\)\)/, '에이전트마다 봇, 이름 = 에이전트 이름(종류 라벨 하드코딩 아님)');
  assert.match(card, /onClick=\{\(\) => addAnother\('hermes'\)\}/, '다른 컴퓨터용 추가는 별도 항목');
  assert.match(card, /supabase\.rpc\('msgr_bot_rotate', \{ bot: b\.id \}\)/);
  assert.match(card, /supabase\.rpc\('msgr_bot_revoke', \{ bot: b\.id \}\)/);
  assert.match(card, /setSetups\(made\); setSetup\(\{ id: made\[0\]\.id, token: made\[0\]\.token, kind \}\)/, '생성 토큰은 화면 상태로만');
  assert.match(card, /<li>\{t\(`org\.agents\.setup\.\$\{setup\.kind \?\? 'custom'\}\.1`\)\}<\/li>/, '종류별 3단계 안내(유건 질문: 두 줄을 어디에 넣나)');
  assert.match(card, /const botSetup = \(token\) => `ARGO_MSGR_URL=\$\{botUrl\}\\nARGO_MSGR_BOT_TOKEN=\$\{token\}`;/, '설정 덩어리 두 줄');
  assert.doesNotMatch(card, /localStorage|console\.log|token_hash/, '토큰 저장·로그 금지');
  assert.match(card, /from\('msgr_bots'\)\.select\('id, crew_id, kind, name, token_hint, created_by, created_at, rotated_at, revoked_at, last_seen_at, external_id'\)/, '봇 표 열(해시 없음)');
  assert.match(card, /const liveBots = bots\.filter\(\(b\) => !b\.revoked_at\)/, '폐기 봇 제외');
  assert.match(card, /confirmRevoke === b\.id && <span className="confirm-inline">/, '해제 인라인 확인(네이티브 confirm 금지)');
  assert.doesNotMatch(card, /window\.confirm|onClick=\{[^}]*(restart|kill)/, 'Buzz 대조: 종료·재시작 버튼 없음, 네이티브 confirm 없음');
});

test('원클릭 연결(유건 지시 "이렇게 어려우면 안 돼"): 앱 안에서 만들기/회전 직후 agent_connect(플러그인 설치·.env·게이트웨이)를 부르고, CLI가 없으면 수동 안내로', () => {
  const card = app.slice(app.indexOf('// ── 부록 N: 외부 에이전트'), app.indexOf("if (part === 'node') return ("));
  assert.match(card, /invoke\('agent_connect', \{ kind, url: botUrl, agents: made\.map/, '앱 커맨드 호출(에이전트 전원)');
  assert.match(card, /autoConnect\(b\.kind, r\.data, b\);/, '회전 직후 자동 연결');
  assert.match(card, /if \(!isDesktopTauri\(\) \|\| !\['hermes', 'openclaw'\]\.includes\(kind\) \|\| !bot\?\.external_id\) \{ setAuto\(null\); return; \}/, '앱 밖·기타 종류·다른 컴퓨터 봇은 수동');
  assert.match(card, /r\?\.reason === 'cli_missing' \? 'missing' : 'failed'/, 'CLI 없음 분기');
  const rs = read('apps/messenger/src-tauri/src/agents.rs');
  assert.match(rs, /pub fn agent_connect\(app: tauri::AppHandle, kind: String, url: String, agents: Vec<AgentSetup>\)/, 'Rust 커맨드(에이전트 배열)');
  assert.match(rs, /pub fn agent_list\(app: tauri::AppHandle, kind: String\)/, '에이전트 목록 커맨드'); assert.match(rs, /\("HERMES_HOME", hh\.display\(\)\.to_string\(\)\)/, '헤르메스 프로필 홈 격리');
  assert.match(rs, /a\.token\.starts_with\("argo_bot_"\) && a\.token\.len\(\) == 57/, '토큰 형식 검사');
  assert.match(rs, /"cli_missing"/, 'CLI 없음 사유'); assert.match(rs, /from_mode\(0o600\)/, '.env 0600');
  assert.doesNotMatch(rs, /println!|eprintln!/, '토큰이 로그로 새지 않게 — 출력 없음');
  const conf = read('apps/messenger/src-tauri/tauri.conf.json');
  assert.match(conf, /"\.\.\/\.\.\/\.\.\/integrations\/hermes-argo-msgr\/": "agents\/hermes-argo-msgr\/"/, '헤르메스 플러그인 동봉');
  assert.match(conf, /"\.\.\/\.\.\/\.\.\/integrations\/openclaw-argo-msgr\/": "agents\/openclaw-argo-msgr\/"/, '오픈클로 플러그인 동봉');
  assert.match(read('apps/messenger/src-tauri/src/lib.rs'), /agents::agent_connect, agents::agent_list/, '핸들러 등록');
});

// Execute the UI identity function with independent installation/user/profile inputs.
test('external IDs cannot auto-adopt another owner, installation, or legacy agent', () => {
  const source = app.match(/export const externalAgentId = ([\s\S]*?\n});/)[1];
  const id = vm.runInNewContext(`(${source})`);
  const a = id('install-a', 'owner-a', 'openclaw', 'main');
  assert.equal(id('install-a', 'owner-a', 'openclaw', 'main'), a);
  assert.notEqual(id('install-b', 'owner-a', 'openclaw', 'main'), a);
  assert.notEqual(id('install-a', 'owner-b', 'openclaw', 'main'), a);
  assert.notEqual(id('install-a', 'owner-a', 'openclaw', 'support'), a);
  assert.notEqual(a, 'openclaw:main');
  assert.notEqual(id('a:b', 'c', 'hermes', 'default'), id('a', 'b:c', 'hermes', 'default'));
  assert.throws(() => id(null, 'owner', 'hermes', 'default'));
  assert.match(app, /b\.created_by === uid && b\.external_id === extId/);
  assert.match(app, /externalAgentId\(l\.installationId, uid, kind, a\.id\) === bot\.external_id/);
  assert.doesNotMatch(app, /external_id\.split/);
});
