#!/usr/bin/env node
// argo — Argo를 터미널·서버에서 쓰는 입구(앱과 같은 코어 src/*.mjs, Next 없이). 유건 결정 2026-09-29:
//   argo                 대화형 화면(로그인·크루와 대화·크루 만들기·AI 연결·메신저 대기·브라우저 준비)
//   argo run             상주 — 메신저·루틴·쪽지·동기화(앱의 서버 기동 순서 instrumentation-node.mjs 그대로). 실행 담당 우선
//   argo chat <크루> [지시] 한 번 실행(지시가 없으면 이어서 대화)
//   argo login | status | browser | service install|uninstall|status
// 회사 데이터는 ~/.argo/workspaces(ARGO_ROOT). 같은 계정의 앱과 동기화로 같은 회사·기억을 본다.
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { applyCliEnv, writeConfig, cliHome, cliLang } from '../src/cli/env.mjs';
import { launchdPlist, systemdUnit } from '../src/cli/service.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = applyCliEnv({ repoRoot: REPO }); // src 모듈보다 먼저(WS_ROOT 고정 전)
const lang = cliLang(cfg);
const [cmd = '', ...rest] = process.argv.slice(2);

const T = {
  ko: {
    noConfig: 'Supabase 공개 설정이 없습니다. ~/.argo/cli.json에 {"supabase":{"url":"…","anonKey":"…"}}를 넣거나 NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY를 설정하세요.',
    loginOpen: '브라우저에서 아래 주소를 열어 로그인하고 "이 터미널 로그인"을 누르세요:', loginSsh: (p, h) => `브라우저가 없는 서버라면 내 PC에서 먼저 실행하세요: ssh -L ${p}:127.0.0.1:${p} ${h}`,
    loginWait: '로그인을 기다리는 중… (Ctrl+C로 취소)', loginDone: (e) => `로그인했습니다: ${e}`, loginTimeout: '10분 안에 로그인하지 않아 취소했습니다.',
    needLogin: '먼저 로그인해야 합니다 — argo login', dead: '기기 세션이 만료·폐기됐습니다. 다시 로그인하세요 — argo login',
    finding: '클라우드에서 회사를 찾는 중…', noCompany: '이 계정의 회사가 없습니다.', newCompany: '새 회사 이름: ', pickCompany: '회사를 고르세요',
    menu: ['크루와 대화', '크루 만들기', 'AI 연결', '메신저 대기(이 터미널에서 상주)', '브라우저 준비', '상태', '나가기'],
    pick: '번호: ', crews: '크루', noCrew: '크루가 없습니다. 먼저 크루를 만드세요.', say: '> ', chatHint: '(빈 줄이나 /나가기로 끝냅니다)',
    working: '작업 중', failed: (m) => `실패: ${m}`, oneLiner: '크루를 한 줄로 설명하세요(예: 쇼핑몰 광고 카피를 쓰는 마케터): ', crewName: '이름(비우면 자동): ', created: (n) => `영입했습니다: ${n}`,
    runners: 'AI 연결', connected: '연결됨', notConnected: '미연결', runnerPick: '연결할 AI 번호: ', method: '방식', secret: '키/토큰(입력은 보이지 않습니다): ',
    verifying: '확인 중…', saved: '연결했습니다.', invalid: '확인에 실패했습니다 — 키를 다시 확인하세요.', hostLogin: '이 컴퓨터 로그인 사용',
    running: (ws) => `상주 중 — 회사 ${ws} · 메신저·루틴·쪽지·동기화. 실행 담당을 우선 맡습니다(Ctrl+C로 종료).`,
    browserFound: (p) => `크루 브라우저: ${p}`, browserNone: '크루 브라우저로 쓸 Chrome/Chromium이 없습니다.', browserInstall: '헤드리스 Chrome을 ~/.argo/browsers에 설치할까요? (y/N) ',
    browserInstalling: '설치 중… (약 100MB)', browserInstalled: (p) => `설치했습니다: ${p}`, browserFail: (m) => `설치 실패: ${m}`,
    egoSeen: 'ego 브라우저 감지됨 — 크루별 로그인 격리가 보장되지 않아 크루 브라우저로 쓰지 않습니다(크루마다 전용 프로필을 씁니다).',
    asideSeen: 'Aside 감지됨 — 크루별 로그인 격리가 보장되지 않아 크루 브라우저로 쓰지 않습니다.',
    headless: '화면이 없는 환경이라 크루 브라우저는 헤드리스로 돕니다(사람이 대신 로그인해 주는 기능은 쓸 수 없습니다).',
    svcDone: (f) => `등록했습니다: ${f} — 재부팅·크래시에도 자동으로 다시 켜집니다.`, svcRemoved: '등록을 해제했습니다.', svcNone: '등록된 서비스가 없습니다.', svcWin: 'Windows 서비스 등록은 아직 지원하지 않습니다 — argo run을 직접 실행하세요.',
    usage: '사용법: argo [run|chat <크루> [지시]|login|status|browser|service install|uninstall|status]',
    status: (s) => `계정: ${s.email || '(로그인 안 됨)'}\n데이터: ${s.root}\n회사: ${s.companies}\n기기: ${s.device}`,
  },
  en: {
    noConfig: 'Missing Supabase public config. Put {"supabase":{"url":"…","anonKey":"…"}} in ~/.argo/cli.json or set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    loginOpen: 'Open this address in a browser, sign in, and press "Sign in this terminal":', loginSsh: (p, h) => `On a server without a browser, run this on your PC first: ssh -L ${p}:127.0.0.1:${p} ${h}`,
    loginWait: 'Waiting for sign-in… (Ctrl+C to cancel)', loginDone: (e) => `Signed in: ${e}`, loginTimeout: 'Cancelled — no sign-in within 10 minutes.',
    needLogin: 'Sign in first — argo login', dead: 'This device session expired or was revoked. Sign in again — argo login',
    finding: 'Looking for your companies in the cloud…', noCompany: 'No company for this account yet.', newCompany: 'New company name: ', pickCompany: 'Choose a company',
    menu: ['Chat with a crew', 'Hire a crew', 'AI connections', 'Messenger standby (run here)', 'Prepare browser', 'Status', 'Quit'],
    pick: 'Number: ', crews: 'Crews', noCrew: 'No crews yet. Hire one first.', say: '> ', chatHint: '(empty line or /quit to leave)',
    working: 'Working', failed: (m) => `Failed: ${m}`, oneLiner: 'Describe the crew in one line (e.g. a marketer who writes ad copy): ', crewName: 'Name (blank = auto): ', created: (n) => `Hired: ${n}`,
    runners: 'AI connections', connected: 'connected', notConnected: 'not connected', runnerPick: 'AI to connect (number): ', method: 'Method', secret: 'Key/token (input hidden): ',
    verifying: 'Checking…', saved: 'Connected.', invalid: 'Check failed — verify the key.', hostLogin: "Use this computer's login",
    running: (ws) => `Running — company ${ws} · messenger, routines, crew mail, sync. This device takes the execution role first (Ctrl+C to stop).`,
    browserFound: (p) => `Crew browser: ${p}`, browserNone: 'No Chrome/Chromium available for the crew browser.', browserInstall: 'Install headless Chrome into ~/.argo/browsers? (y/N) ',
    browserInstalling: 'Installing… (about 100MB)', browserInstalled: (p) => `Installed: ${p}`, browserFail: (m) => `Install failed: ${m}`,
    egoSeen: 'ego browser detected — not used for crews because per-crew login isolation is not guaranteed (each crew keeps its own profile).',
    asideSeen: 'Aside detected — not used for crews because per-crew login isolation is not guaranteed.',
    headless: 'No display here, so the crew browser runs headless (handing a login to a person is unavailable).',
    svcDone: (f) => `Registered: ${f} — restarts automatically after reboots and crashes.`, svcRemoved: 'Unregistered.', svcNone: 'No service registered.', svcWin: 'Windows service registration is not supported yet — run argo run directly.',
    usage: 'Usage: argo [run|chat <crew> [message]|login|status|browser|service install|uninstall|status]',
    status: (s) => `Account: ${s.email || '(not signed in)'}\nData: ${s.root}\nCompanies: ${s.companies}\nDevice: ${s.device}`,
  },
}[lang];

/* ─── 입력 ─── */
let muted = false;
const out = new Writable({ write(chunk, _e, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: out, terminal: true }) : null;
const ask = async (q) => (rl ? (await rl.question(q)).trim() : '');
const askSecret = async (q) => { process.stdout.write(q); muted = true; try { return await ask(''); } finally { muted = false; process.stdout.write('\n'); } };
async function choose(title, items) {
  console.log(`\n${title}`); items.forEach((it, i) => console.log(`  ${i + 1}. ${it}`));
  const n = Number(await ask(T.pick)); return n >= 1 && n <= items.length ? n - 1 : -1;
}
const hasDisplay = () => process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
function openUrl(url) {
  if (!hasDisplay()) return;
  const [bin, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(bin, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* 주소는 이미 화면에 있다 */ }
}

/* ─── 로그인·회사 ─── */
async function currentSession() {
  const d = await import('../src/devicesession.mjs');
  const s = d.loadDeviceSession();
  return s && !d.deviceSessionDead() ? s : null;
}
async function login() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) { console.error(T.noConfig); process.exit(1); }
  const { startLoginServer } = await import('../src/cli/login.mjs');
  const srv = await startLoginServer({ supabaseUrl: url, anonKey, lang, port: Number(process.env.ARGO_LOGIN_PORT) || undefined });
  console.log(`${T.loginOpen}\n\n  ${srv.url}\n`);
  if (!hasDisplay()) console.log(`${T.loginSsh(srv.port, `${process.env.USER ?? 'user'}@${hostname()}`)}\n`);
  openUrl(srv.url); console.log(T.loginWait);
  const timer = setTimeout(() => { console.error(T.loginTimeout); process.exit(1); }, 10 * 60_000);
  const user = await srv.done; clearTimeout(timer); await srv.close();
  console.log(T.loginDone(user.email || user.id));
  return user;
}
async function requireSession({ interactive }) {
  let s = await currentSession();
  if (!s && interactive) { await login(); s = await currentSession(); }
  if (!s) { const { deviceSessionDead } = await import('../src/devicesession.mjs'); console.error(deviceSessionDead() ? T.dead : T.needLogin); process.exit(1); }
  return s;
}
async function ownCompanies(uid) {
  const { listCompanies } = await import('../src/hub.mjs');
  return (await listCompanies()).filter((c) => c.ownerId === uid);
}
/** 회사 고르기 — 로컬에 없으면 동기화로 클라우드에서 찾아 온다(최대 40초). 대화형이면 새로 만들 수 있다. */
async function pickCompany(uid, { interactive }) {
  let list = await ownCompanies(uid);
  if (!list.length) {
    const { ensureSync } = await import('../src/sync.mjs'); ensureSync();
    console.log(T.finding);
    for (let i = 0; i < 20 && !list.length; i++) { await new Promise((r) => setTimeout(r, 2000)); list = await ownCompanies(uid); }
  }
  const saved = list.find((c) => c.id === cfg.ws);
  if (saved) return saved.id;
  if (list.length === 1) return list[0].id;
  if (list.length > 1 && interactive) { const i = await choose(T.pickCompany, list.map((c) => `${c.name} (${c.id})`)); if (i >= 0) { writeConfig({ ws: list[i].id }); return list[i].id; } }
  if (!interactive) { console.error(T.noCompany); process.exit(1); }
  console.log(T.noCompany);
  const name = await ask(T.newCompany); if (!name) process.exit(0);
  const { createCompany } = await import('../src/workspace.mjs');
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); // 앱과 같은 규칙(app/api/companies/route.js)
  const ws = `${base || 'co'}-${Date.now().toString(36).slice(-4)}`;
  await createCompany(ws, name, 'captain', uid, lang); // 표준 스캐폴드(vault 위키 트리)를 앱과 같은 함수로 만든다
  writeConfig({ ws }); return ws;
}

/* ─── 크루와 대화 — 앱 채팅 라우트와 같은 기록 순서(beginTurn → chat → appendTurn)라 앱에서도 같은 대화가 보인다 ─── */
async function turn(ws, slug, message, sessionId) {
  const { chat } = await import('../src/chat.mjs');
  const { beginTurn, appendTurn } = await import('../src/thread.mjs');
  const { getTurnStatus } = await import('../src/turn-status.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const turnId = await beginTurn(ws, slug, { userMsg: message }).catch(() => null);
  let last = '';
  const tick = setInterval(async () => {
    const st = await getTurnStatus(ws, slug).catch(() => null);
    const line = st?.detail ? `${T.working}: ${st.detail}` : `${T.working}…`; // stage는 앱이 번역하는 코드라 내보이지 않는다
    if (line !== last && process.stdout.isTTY) { process.stdout.write(`\r\x1b[2K${line.slice(0, (process.stdout.columns || 80) - 1)}`); last = line; }
  }, 1500);
  try {
    const t = await chat(ws, slug, message, sessionId, { ...(turnId ? { abortTag: turnId } : {}) });
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    await appendTurn(ws, slug, { turnId, userMsg: message, reply: t.reply, handover, sessionId: t.sessionId, steerFailed: t.steerFailed, artifacts: t.artifacts, fellBack: t.fellBack, modelFallback: t.modelFallback });
    return t;
  } catch (e) {
    await appendTurn(ws, slug, { turnId, userMsg: message, failed: String(e?.message || e), aborted: !!e?.aborted, failedCode: e?.failCode ?? null }).catch(() => {});
    throw e;
  } finally { clearInterval(tick); if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K'); }
}
async function chatLoop(ws, slug, first) {
  const { loadThread } = await import('../src/thread.mjs');
  let sid = (await loadThread(ws, slug)).sessionId ?? null;
  let msg = first;
  if (!msg) console.log(T.chatHint);
  for (;;) {
    if (!msg) msg = await ask(T.say);
    if (!msg || /^\/(나가기|quit|exit)$/i.test(msg)) return;
    try { const t = await turn(ws, slug, msg, sid); sid = t.sessionId ?? sid; console.log(`\n${t.reply}\n`); }
    catch (e) { console.error(T.failed(String(e?.message || e).slice(0, 400))); }
    if (first) return; // argo chat <크루> "지시" — 한 번 실행
    msg = '';
  }
}
async function pickCrew(ws) {
  const { listAgents } = await import('../src/hub.mjs');
  const crews = await listAgents(ws);
  if (!crews.length) { console.log(T.noCrew); return null; }
  const i = await choose(T.crews, crews.map((c) => `${c.name}${c.role ? ` — ${c.role}` : ''} (${c.slug})`));
  return i >= 0 ? crews[i].slug : null;
}
async function hireCrew(ws) {
  const line = await ask(T.oneLiner); if (!line) return;
  const name = await ask(T.crewName);
  const { createAgentFromPrompt } = await import('../src/persona.mjs');
  try { const a = await createAgentFromPrompt(ws, line, name ? { name } : {}); console.log(T.created(a.name)); }
  catch (e) { console.error(T.failed(String(e?.message || e).slice(0, 300))); }
}

/* ─── AI 연결 ─── */
async function runnersMenu(ws) {
  const { runnerStatus } = await import('../src/runners.mjs');
  const { RUNNER_AUTH, visibleRunnerIds } = await import('../src/runners/catalog.mjs');
  const { saveRunnerCred, verifyRunnerCred } = await import('../src/runners/creds.mjs');
  const st = await runnerStatus(ws);
  const ids = visibleRunnerIds().filter((id) => RUNNER_AUTH[id]);
  const i = await choose(T.runners, ids.map((id) => `${st[id]?.name ?? id} — ${st[id]?.company?.connected ? T.connected : T.notConnected}`));
  if (i < 0) return;
  const id = ids[i]; const meta = RUNNER_AUTH[id];
  const methods = [...meta.methods.filter((m) => m === 'apikey' || (m === 'oauth' && meta.oauthPasteable)), ...(st[id]?.hostUsable ? ['host'] : [])];
  const m = methods.length > 1 ? methods[await choose(T.method, methods.map((x) => (x === 'host' ? T.hostLogin : x === 'oauth' ? `OAuth ${meta.oauthEnv ?? ''}`.trim() : 'API key')))] : methods[0];
  if (!m) return;
  if (m === 'host') { await saveRunnerCred(ws, id, 'host', 'host'); console.log(T.saved); return; }
  if (meta.keyUrl) console.log(meta.keyUrl);
  const value = await askSecret(T.secret); if (!value) return;
  console.log(T.verifying);
  const v = await verifyRunnerCred(id, m, value).catch(() => ({ ok: false }));
  if (!v?.ok) { console.error(T.invalid); return; }
  await saveRunnerCred(ws, id, m, value); console.log(T.saved); // 값은 출력하지 않는다
}

/* ─── 브라우저 준비 — 크루 전용 프로필 원칙 유지. 없으면 헤드리스 Chrome을 ~/.argo/browsers에 받는다 ─── */
async function browserMenu({ interactive }) {
  const { findChrome } = await import('../src/engine/browser-tools.mjs');
  const { detectEgoBrowser } = await import('../src/engine/ego-browser-provider.mjs');
  if (process.env.ARGO_BROWSER_HEADLESS === '1') console.log(T.headless);
  if ((await detectEgoBrowser({ timeoutMs: 3000 }).catch(() => ({}))).available) console.log(T.egoSeen);
  if (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['aside'], { stdio: 'ignore' }).status === 0) console.log(T.asideSeen);
  const found = findChrome(process.env);
  if (found) { console.log(T.browserFound(found)); return; }
  console.log(T.browserNone);
  if (!interactive || !/^y/i.test(await ask(T.browserInstall))) return;
  console.log(T.browserInstalling);
  const dir = join(cliHome(), 'browsers');
  const r = spawnSync('npx', ['-y', '@puppeteer/browsers', 'install', 'chrome-headless-shell@stable', '--path', dir], { encoding: 'utf8' });
  const path = String(r.stdout ?? '').trim().split('\n').pop()?.split(' ').slice(1).join(' ');
  if (r.status !== 0 || !path || !existsSync(path)) { console.error(T.browserFail(String(r.stderr || r.stdout || '').trim().slice(-300))); return; }
  writeConfig({ chromePath: path }); process.env.ARGO_CHROME_PATH = path; console.log(T.browserInstalled(path));
}

/* ─── 상주 ─── */
async function runResident({ prefer = true } = {}) {
  const s = await requireSession({ interactive: false });
  if (prefer) process.env.ARGO_PREFER_LEADER = '1';
  delete process.env.ARGO_NO_LEADER;
  // 회사를 고르지 않는다 — 없으면 동기화가 클라우드에서 찾아오고, 게이트웨이는 이 계정의 모든 회사를 맡는다(앱 서버와 같다)
  const ws = (await ownCompanies(s.user.id)).map((c) => c.name).join(', ');
  await import('../instrumentation-node.mjs'); // 앱 서버가 켜질 때와 같은 순서 — 스케줄러·게이트웨이(메신저·텔레그램·스캐폴드 백필)·동기화·고아 턴 정리
  console.log(T.running(ws || '-'));
  const stop = () => process.exit(0);
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

/* ─── 서비스 등록(argo run 상주) — 사용자 권한만. 로그 위치는 기존 상주와 따로 ─── */
function service(action) {
  const node = process.execPath; const bin = fileURLToPath(import.meta.url);
  const env = { ARGO_ROOT: process.env.ARGO_ROOT ?? '', ...(cfg.lang ? { LANG: cfg.lang === 'en' ? 'en_US.UTF-8' : 'ko_KR.UTF-8' } : {}) };
  if (process.platform === 'linux') {
    const f = join(homedir(), '.config', 'systemd', 'user', 'argo-cli.service');
    if (action === 'install') {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, systemdUnit({ node, bin, env }));
      spawnSync('systemctl', ['--user', 'daemon-reload']); spawnSync('systemctl', ['--user', 'enable', '--now', 'argo-cli.service'], { stdio: 'inherit' });
      spawnSync('loginctl', ['enable-linger', process.env.USER ?? ''], { stdio: 'ignore' }); // 로그아웃·재부팅 뒤에도 유지
      return console.log(T.svcDone(f));
    }
    if (action === 'uninstall') { spawnSync('systemctl', ['--user', 'disable', '--now', 'argo-cli.service'], { stdio: 'inherit' }); rmSync(f, { force: true }); return console.log(T.svcRemoved); }
    return existsSync(f) ? spawnSync('systemctl', ['--user', 'status', '--no-pager', 'argo-cli.service'], { stdio: 'inherit' }) : console.log(T.svcNone);
  }
  if (process.platform === 'darwin') {
    const label = 'com.beyondworks.argo-cli'; const f = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const log = join(homedir(), 'Library', 'Logs', 'argo-cli.log');
    if (action === 'install') {
      writeFileSync(f, launchdPlist({ label, node, bin, env, log }));
      spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
      spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, f], { stdio: 'inherit' });
      return console.log(T.svcDone(f));
    }
    if (action === 'uninstall') { spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); rmSync(f, { force: true }); return console.log(T.svcRemoved); }
    return existsSync(f) ? spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'inherit' }) : console.log(T.svcNone);
  }
  console.log(T.svcWin);
}

async function status() {
  const s = await currentSession();
  const { getDeviceId } = await import('../src/workspace.mjs');
  const companies = s ? (await ownCompanies(s.user.id)).map((c) => `${c.name} (${c.id})`).join(', ') || '-' : '-';
  console.log(T.status({ email: s?.user?.email, root: process.env.ARGO_ROOT, companies, device: await getDeviceId() }));
}

/* ─── 입구 ─── */
async function interactive() {
  process.env.ARGO_NO_LEADER = '1'; // 대화 화면은 동기화만 — 실행 담당(메신저·루틴)은 맡지 않는다(argo run이 맡는다)
  const s = await requireSession({ interactive: true });
  const ws = await pickCompany(s.user.id, { interactive: true });
  const { ensureSync } = await import('../src/sync.mjs'); ensureSync(); // 여기서 한 대화가 앱에도 보이게
  for (;;) {
    const i = await choose(`Argo · ${s.user.email ?? ''} · ${ws}`, T.menu);
    if (i === 0) { const slug = await pickCrew(ws); if (slug) await chatLoop(ws, slug, ''); }
    else if (i === 1) await hireCrew(ws);
    else if (i === 2) await runnersMenu(ws);
    else if (i === 3) { rl?.close(); await runResident(); return; }
    else if (i === 4) await browserMenu({ interactive: true });
    else if (i === 5) await status();
    else if (i === 6 || i < 0) { rl?.close(); process.exit(0); }
  }
}

try {
  if (cmd === '') await interactive();
  else if (cmd === 'run') { rl?.close(); await runResident({ prefer: !rest.includes('--no-prefer') }); }
  else if (cmd === 'login') { await login(); process.exit(0); }
  else if (cmd === 'status') { await status(); process.exit(0); }
  else if (cmd === 'browser') { await browserMenu({ interactive: !!rl }); process.exit(0); }
  else if (cmd === 'service') { service(rest[0] ?? 'status'); process.exit(0); }
  else if (cmd === 'chat') {
    process.env.ARGO_NO_LEADER = '1';
    const s = await requireSession({ interactive: false });
    const ws = await pickCompany(s.user.id, { interactive: !!rl });
    const { listAgents } = await import('../src/hub.mjs');
    const want = rest[0]; const crew = (await listAgents(ws)).find((c) => c.slug === want || c.name === want);
    if (!crew) { console.error(T.noCrew); process.exit(1); }
    await chatLoop(ws, crew.slug, rest.slice(1).join(' '));
    process.exit(0);
  } else { console.log(T.usage); process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1); }
} catch (e) {
  console.error(T.failed(String(e?.message || e)));
  process.exit(1);
}
