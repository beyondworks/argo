// 부록 N-3 — 메신저 설정 "외부 에이전트" 카드·봇 표기. JSX는 소스 구간 핀으로 잠근다(코드 검수 관례). 서버 판정은 test/msgr-bots-pg.test.mjs, 라우트는 msgr-bot-facade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t } from '../apps/messenger/src/i18n.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const app = read('apps/messenger/src/App.jsx');
const i18n = read('apps/messenger/src/i18n.js');
const KEYS = ['crew.hosting.bot', 'org.agents', 'org.agents.desc', 'org.agents.none', 'org.agents.add.hermes', 'org.agents.add.openclaw', 'org.agents.add.custom', 'org.agents.kind.hermes', 'org.agents.kind.openclaw', 'org.agents.kind.custom', 'org.agents.waiting', 'org.agents.on', 'org.agents.off', 'org.agents.by', 'org.agents.made', 'org.agents.rotated', 'org.agents.setup.h', 'org.agents.copy', 'org.agents.copied', 'org.agents.setup.hint', 'org.agents.rotate', 'org.agents.revoke', 'org.agents.revoke.confirm', 'org.agents.revoke.done', 'org.agents.setup.hermes.1', 'org.agents.setup.hermes.2', 'org.agents.setup.hermes.3', 'org.agents.setup.openclaw.1', 'org.agents.setup.openclaw.2', 'org.agents.setup.openclaw.3', 'org.agents.setup.custom.1', 'org.agents.setup.custom.2', 'org.agents.setup.custom.3', 'org.agents.auto.running', 'org.agents.auto.done', 'org.agents.auto.after', 'org.agents.auto.failed', 'org.agents.auto.missing', 'org.agents.auto.retry', 'org.agents.auto.step.plugin', 'org.agents.auto.step.env', 'org.agents.auto.step.enable', 'org.agents.auto.step.gateway', 'org.agents.setup.manual', 'org.agents.reconnect', 'org.agents.reconnect.title', 'org.agents.another', 'org.agents.name.mine'];

test('카드가 쓰는 i18n 키는 전부 ko/en 쌍 · 상태 문구는 "헤르메스 에이전트 연결중/연결됨/응답 없음"(유건 지정 표기)', () => {
  for (const k of KEYS) assert.match(i18n, new RegExp(`'${k.replace(/\./g, '\\.')}': \\['[^']+', '[^']+'\\]`), `${k} ko/en`);
  assert.equal(t('org.agents.waiting', 'ko', { kind: t('org.agents.kind.hermes', 'ko') }), '헤르메스 에이전트 연결중 · 아직 접속 없음');
  assert.equal(t('org.agents.on', 'ko', { kind: t('org.agents.kind.openclaw', 'ko'), when: '10:00' }), '오픈클로 에이전트 연결됨 · 10:00');
  assert.equal(t('org.agents.off', 'ko', { kind: '헤르메스', when: '10:00' }), '헤르메스 에이전트 응답 없음 · 마지막 10:00');
  assert.doesNotMatch(i18n.slice(i18n.indexOf("'org.agents'"), i18n.indexOf("'org.node.hint'")), /HTTP/, '유건 지시: 화면 표기에 HTTP 같은 기술 용어 금지');
});

test('봇 = 회사 등급(클라이언트 crewTier) · 내 크루 레일에서 제외 · 시트 hosting 표기 · 설정 크루 탭에 카드', () => {
  assert.match(app, /export const crewTier = \(crew, org\) => \(crew\?\.hosting === 'bot' \|\| /, '봇 회사 등급');
  assert.match(app, /const myCrews = crews\.filter\(\(c\) => c\.owner_user_id === uid && c\.hosting !== 'bot'\);/, '내 크루 정의 한 곳');
  assert.equal((app.match(/myCrews/g) ?? []).length, 6, '그룹 표시·개수·목록·힌트가 전부 myCrews를 쓴다(정의 1 + 소비 5)');
  assert.doesNotMatch(app, /crews\.filter\(\(c\) => c\.owner_user_id === uid\)|crews\.some\(\(c\) => c\.owner_user_id === uid\)/, '봇 포함 옛 필터 잔존(실측: 한 줄에 두 번 있어 치환이 하나 남았다)');
  assert.match(read('apps/messenger/src/styles.css'), /\.msgr-node-cmd code \{[^}]*white-space: pre-wrap;/, '설정 두 줄이 줄바꿈으로 보인다(실측: 한 줄로 붙어 보였다)');
  assert.match(app, /crew\.hosting === 'resident' \? 'resident' : crew\.hosting === 'bot' \? 'bot' : 'local'/, '시트 hosting 표기');
  assert.match(app, /<OrgCard part="node"[^\n]*\n\s*\{isAdmin && <OrgCard part="agents"/, '크루 탭에서 노드 카드 다음에 에이전트 카드(관리자만)');
});

test('카드: 생성·회전은 RPC(토큰은 응답에서 setup 상태로만) · 설정 두 줄 = URL+토큰 · 해제는 인라인 확인 · 표는 폐기 제외', () => {
  const card = app.slice(app.indexOf('// ── 부록 N: 외부 에이전트'), app.indexOf("if (part === 'node') return ("));
  assert.match(card, /supabase\.rpc\('msgr_bot_create', \{ org: org\.id, kind, name \}\)/);
  assert.match(card, /if \(mine && !another && kind !== 'custom'\) return rotateBot\(mine\);/, '같은 종류의 내 봇이 있으면 새로 만들지 않고 다시 연결(유건 지적: 누를 때마다 추가됨)');
  assert.match(card, /t\('org\.agents\.name\.mine', \{ who: nameOfUser\(uid\), kind:/, '봇 이름에 만든 사람');
  assert.match(card, /addBot\('hermes', \{ another: true \}\)/, '다른 컴퓨터용 추가는 별도 항목');
  assert.match(card, /supabase\.rpc\('msgr_bot_rotate', \{ bot: b\.id \}\)/);
  assert.match(card, /supabase\.rpc\('msgr_bot_revoke', \{ bot: b\.id \}\)/);
  assert.match(card, /setSetup\(\{ id: r\.data\.bot_id, token: r\.data\.token, kind \}\)/, '생성 토큰은 화면 상태로만(종류 포함 — 종류별 설치 단계)');
  assert.match(card, /<li>\{t\(`org\.agents\.setup\.\$\{setup\.kind \?\? 'custom'\}\.1`\)\}<\/li>/, '종류별 3단계 안내(유건 질문: 두 줄을 어디에 넣나)');
  assert.match(card, /const botSetup = \(token\) => `ARGO_MSGR_URL=\$\{SB_URL\}\/functions\/v1\/msgr-bot\\nARGO_MSGR_BOT_TOKEN=\$\{token\}`;/, '설정 덩어리 두 줄');
  assert.doesNotMatch(card, /localStorage|console\.log|token_hash/, '토큰 저장·로그 금지');
  assert.match(card, /from\('msgr_bots'\)\.select\('id, crew_id, kind, name, token_hint, created_by, created_at, rotated_at, revoked_at, last_seen_at'\)/, '봇 표 열(해시 없음)');
  assert.match(card, /const liveBots = bots\.filter\(\(b\) => !b\.revoked_at\)/, '폐기 봇 제외');
  assert.match(card, /confirmRevoke === b\.id && <span className="confirm-inline">/, '해제 인라인 확인(네이티브 confirm 금지)');
  assert.doesNotMatch(card, /window\.confirm|onClick=\{[^}]*(restart|kill)/, 'Buzz 대조: 종료·재시작 버튼 없음, 네이티브 confirm 없음');
});

test('원클릭 연결(유건 지시 "이렇게 어려우면 안 돼"): 앱 안에서 만들기/회전 직후 agent_connect(플러그인 설치·.env·게이트웨이)를 부르고, CLI가 없으면 수동 안내로', () => {
  const card = app.slice(app.indexOf('// ── 부록 N: 외부 에이전트'), app.indexOf("if (part === 'node') return ("));
  assert.match(card, /invoke\('agent_connect', \{ kind, url: `\$\{SB_URL\}\/functions\/v1\/msgr-bot`, token \}\)/, '앱 커맨드 호출');
  assert.match(card, /autoConnect\(kind, r\.data\.token\);/, '만들기 직후 자동 연결'); assert.match(card, /autoConnect\(b\.kind, r\.data\);/, '회전 직후 자동 연결');
  assert.match(card, /if \(!inTauri\(\) \|\| !\['hermes', 'openclaw'\]\.includes\(kind\)\) \{ setAuto\(null\); return; \}/, '앱 밖·기타 종류는 수동');
  assert.match(card, /r\?\.reason === 'cli_missing' \? 'missing' : 'failed'/, 'CLI 없음 분기');
  const rs = read('apps/messenger/src-tauri/src/agents.rs');
  assert.match(rs, /pub fn agent_connect\(app: tauri::AppHandle, kind: String, url: String, token: String\)/, 'Rust 커맨드');
  assert.match(rs, /token\.starts_with\("argo_bot_"\) && token\.len\(\) == 57/, '토큰 형식 검사');
  assert.match(rs, /"cli_missing"/, 'CLI 없음 사유'); assert.match(rs, /from_mode\(0o600\)/, '.env 0600');
  assert.doesNotMatch(rs, /println!|eprintln!/, '토큰이 로그로 새지 않게 — 출력 없음');
  const conf = read('apps/messenger/src-tauri/tauri.conf.json');
  assert.match(conf, /"\.\.\/\.\.\/\.\.\/integrations\/hermes-argo-msgr\/": "agents\/hermes-argo-msgr\/"/, '헤르메스 플러그인 동봉');
  assert.match(conf, /"\.\.\/\.\.\/\.\.\/integrations\/openclaw-argo-msgr\/": "agents\/openclaw-argo-msgr\/"/, '오픈클로 플러그인 동봉');
  assert.match(read('apps/messenger/src-tauri/src/lib.rs'), /agents::agent_connect/, '핸들러 등록');
});
