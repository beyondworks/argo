#!/usr/bin/env node
// argo — Argo를 터미널·서버에서 쓰는 입구(앱과 같은 코어 src/*.mjs, Next 없이). 유건 결정 2026-09-29:
//   argo                 대화 화면 — 심볼·버전 머리 뒤 바로 크루와 대화, 나머지는 /명령(Claude Code 터미널처럼, 유건 결정 2026-09-30).
//                        나가기는 /quit·exit만. Ctrl+C는 답하는 중이면 그 턴만 멈추고, 입력 중이면 줄을 지운다.
//   argo run             상주 — 메신저·루틴·쪽지·동기화(앱의 서버 기동 순서 instrumentation-node.mjs 그대로). 실행 담당 우선
//   argo chat <크루> [지시] 한 번 실행(지시가 없으면 이어서 대화)
//   argo login | status | browser | service install|uninstall|status
// 회사 데이터는 ~/.argo/cli-workspaces(ARGO_ROOT) — 같은 맥의 상주·앱 폴더와 따로(기기 세션 단일 소유). 같은 계정의 앱과 동기화로 같은 회사·기억을 본다.
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { applyCliEnv, writeConfig, cliHome, cliLang } from '../src/cli/env.mjs';
import { launchdPlist, systemdUnit } from '../src/cli/service.mjs';
import { banner, parseInput, style, fit, termWidth, isCoreLog, cliHintText } from '../src/cli/ui.mjs';

// 사용자에게 필요 없는 경고는 숨긴다 — node:sqlite(기억 인덱스)의 ExperimentalWarning, SDK의 canUseTool 안내
// (Argo는 도구 허용을 PreToolUse 훅으로 처리한다 — #587). 대화 중 진행 줄 사이에 끼어들었다(실측). 다른 경고는 그대로 보인다.
const QUIET_WARNINGS = new Set(['CLAUDE_SDK_CAN_USE_TOOL_SHADOWED']);
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w?.name !== 'ExperimentalWarning' && !QUIET_WARNINGS.has(w?.code)) console.warn(`${w.name}: ${w.message}`); });

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
    pick: '번호: ', crews: '대화할 크루를 고르세요', noCrew: '크루가 없습니다. /hire로 크루를 영입하세요.', chatHint: '(빈 줄이나 /quit로 끝냅니다)',
    working: '작업 중', stopHint: 'Ctrl+C로 멈춤', stopping: '멈추는 중…', stopped: '멈췄습니다.', queued: '답이 끝나면 보냅니다',
    talkingTo: (n) => `대화 상대: ${n}`, headHint: '/crew 크루 바꾸기  /help 명령 보기  /quit 나가기',
    quitHint: '나가려면 /quit 또는 exit를 입력하세요.', unknownCmd: (n) => `모르는 명령입니다: /${n} — /help로 명령을 볼 수 있습니다.`,
    newDone: '새 대화를 시작했습니다. 이전 대화는 앱의 대화 기록에 보관됩니다.', serveStart: '이 터미널에서 메신저 대기를 시작합니다. 끝내려면 Ctrl+C를 누르세요.',
    noTty: 'argo 대화 화면은 터미널에서 실행하세요. 스크립트에서는 argo chat <크루> "지시"를 쓰세요.',
    noRunner: '이 기기에는 아직 AI가 연결되지 않았습니다. /ai로 연결하세요(연결 정보는 기기마다 따로 두고 클라우드로 보내지 않습니다).',
    hostAvail: (names) => `이 컴퓨터에 로그인되어 있는 AI(${names})는 /ai에서 "이 컴퓨터 로그인 사용"으로 바로 연결할 수 있습니다.`,
    help: [['/crew [이름]', '대화할 크루 바꾸기'], ['/new', '새 대화 시작(지금 대화는 보관)'], ['/hire', '크루 영입'], ['/ai', 'AI 연결'],
      ['/serve', '이 터미널에서 메신저 대기(상주)'], ['/browser', '크루 브라우저 준비'], ['/status', '계정·회사·기기 상태'], ['/quit, exit', '나가기'],
      ['Ctrl+C', '답하는 중이면 멈추기, 입력 중이면 지우기']], failed: (m) => `실패: ${m}`, oneLiner: '크루를 한 줄로 설명하세요(예: 쇼핑몰 광고 카피를 쓰는 마케터): ', crewName: '이름(비우면 자동): ', created: (n) => `영입했습니다: ${n}`,
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
    pick: 'Number: ', crews: 'Choose a crew to talk to', noCrew: 'No crews yet. Hire one with /hire.', chatHint: '(empty line or /quit to leave)',
    working: 'Working', stopHint: 'Ctrl+C to stop', stopping: 'Stopping…', stopped: 'Stopped.', queued: 'will send when the reply ends',
    talkingTo: (n) => `Talking to: ${n}`, headHint: '/crew switch crew  /help commands  /quit leave',
    quitHint: 'Type /quit or exit to leave.', unknownCmd: (n) => `Unknown command: /${n} — see /help.`,
    newDone: 'Started a new conversation. The previous one is kept in the app\'s history.', serveStart: 'Starting messenger standby in this terminal. Press Ctrl+C to stop.',
    noTty: 'Run the argo chat screen in a terminal. From scripts, use argo chat <crew> "message".',
    noRunner: 'No AI is connected on this device yet. Connect one with /ai (connection details stay on each device and never go to the cloud).',
    hostAvail: (names) => `${names} is signed in on this computer — in /ai choose "Use this computer's login" to connect right away.`,
    help: [['/crew [name]', 'switch crew'], ['/new', 'start a new conversation (current one is kept)'], ['/hire', 'hire a crew'], ['/ai', 'AI connections'],
      ['/serve', 'messenger standby in this terminal'], ['/browser', 'prepare the crew browser'], ['/status', 'account, company, device'], ['/quit, exit', 'leave'],
      ['Ctrl+C', 'stop the reply, or clear the line']], failed: (m) => `Failed: ${m}`, oneLiner: 'Describe the crew in one line (e.g. a marketer who writes ad copy): ', crewName: 'Name (blank = auto): ', created: (n) => `Hired: ${n}`,
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
let onSigint = null; // 대화 화면이 켜지면 Ctrl+C를 가져간다(나가지 않음). 그 전(로그인·회사 고르기)은 종전대로 종료.
let onQueuedLine = null; // 답하는 중에 친 줄 — 질문이 떠 있지 않을 때 readline이 'line'으로만 알린다
const makeRl = () => {
  if (!process.stdin.isTTY) return null;
  const r = createInterface({ input: process.stdin, output: out, terminal: true });
  r.on('SIGINT', () => (onSigint ? onSigint() : process.exit(130)));
  r.on('line', (l) => onQueuedLine?.(l));
  return r;
};
let rl = makeRl();
const ask = async (q) => {
  for (;;) {
    if (!rl) return '';
    try { return (await rl.question(q)).trim(); }
    catch (e) {
      // Ctrl+D는 입력을 닫는다(실측) — 대화 화면은 /quit·exit로만 닫으므로 입력을 다시 연다. 그 밖(로그인 등)은 종전대로.
      if (!onSigint || e?.code !== 'ABORT_ERR') throw e;
      if (rl.closed) rl = makeRl();
    }
  }
};
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
const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const { bold, dim } = style(color);
const cols = () => process.stdout.columns || 80;
let current = null; // 답하는 중인 턴 { ws, slug, turnId, stopping }
/** 크루 답을 문단 단위로 흘려 보인다 — 턴 상태의 partial(크루가 이미 말한 텍스트)을 따라가고, 끝나면 남은 부분만 붙인다. */
async function turn(ws, crew, message, sessionId) {
  const { chat } = await import('../src/chat.mjs');
  const { beginTurn, appendTurn } = await import('../src/thread.mjs');
  const { getTurnStatus } = await import('../src/turn-status.mjs');
  const { paths } = await import('../src/workspace.mjs');
  const turnId = await beginTurn(ws, crew.slug, { userMsg: message }).catch(() => null);
  const tty = !!process.stdout.isTTY; const t0 = Date.now();
  let printed = ''; let statusShown = false;
  const clearStatus = () => { if (statusShown) { process.stdout.write('\r\x1b[2K'); statusShown = false; } };
  const say = (text) => {
    clearStatus();
    if (!printed) process.stdout.write(`\n  ${bold(crew.name)}\n`);
    process.stdout.write(text.split('\n').map((l) => `  ${l}`).join('\n'));
  };
  current = { ws, slug: crew.slug, turnId, stopping: false };
  const draw = (detail) => {
    if (!tty) return;
    const sec = Math.round((Date.now() - t0) / 1000);
    const what = current?.stopping ? T.stopping : `${T.working}${detail ? ` — ${detail}` : '…'}`;
    process.stdout.write(`\r\x1b[2K${dim(fit(`  ${crew.name} · ${what}  (${sec}s · ${T.stopHint})`, cols()))}`); statusShown = true;
  };
  const tick = setInterval(async () => {
    const st = await getTurnStatus(ws, crew.slug).catch(() => null);
    const partial = st?.partial ?? '';
    if (partial.length > printed.length && partial.startsWith(printed)) { say(partial.slice(printed.length)); printed = partial; process.stdout.write('\n'); }
    draw(st?.detail ?? ''); // stage는 앱이 번역하는 코드라 내보이지 않는다
  }, 800);
  draw('');
  try {
    const t = await chat(ws, crew.slug, message, sessionId, { ...(turnId ? { abortTag: turnId } : {}) });
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    await appendTurn(ws, crew.slug, { turnId, userMsg: message, reply: t.reply, handover, sessionId: t.sessionId, steerFailed: t.steerFailed, artifacts: t.artifacts, fellBack: t.fellBack, modelFallback: t.modelFallback });
    clearInterval(tick);
    const reply = String(t.reply ?? '');
    let same = 0; while (same < printed.length && same < reply.length && printed[same] === reply[same]) same++;
    const rest = reply.slice(same).replace(/^\n+/, '');
    if (rest) say(rest);
    clearStatus(); process.stdout.write('\n\n');
    return t;
  } catch (e) {
    clearInterval(tick); clearStatus();
    await appendTurn(ws, crew.slug, { turnId, userMsg: message, failed: String(e?.message || e), aborted: !!e?.aborted, failedCode: e?.failCode ?? null }).catch(() => {});
    throw e;
  } finally { clearInterval(tick); current = null; }
}
/** argo chat <크루> [지시] — 한 번 실행하거나(지시 있음) 간단히 이어서 대화 */
async function chatLoop(ws, crew, first) {
  const { loadThread } = await import('../src/thread.mjs');
  let sid = (await loadThread(ws, crew.slug)).sessionId ?? null;
  let msg = first;
  if (!msg) console.log(T.chatHint);
  for (;;) {
    if (!msg) msg = await ask('› ');
    if (!msg || parseInput(msg).kind === 'quit') return;
    try { const t = await turn(ws, crew, msg, sid); sid = t.sessionId ?? sid; }
    catch (e) { console.error(e?.aborted ? T.stopped : T.failed(String(e?.message || e).slice(0, 400))); }
    if (first) return;
    msg = '';
  }
}
/** 대화할 크루 — want(이름·slug) → 이 회사에서 마지막으로 대화한 크루 → 한 명뿐이면 그 크루 → 고르기. 고른 크루는 회사별로 기억한다. */
async function pickCrew(ws, want = '') {
  const { listAgents } = await import('../src/hub.mjs');
  const crews = await listAgents(ws);
  if (!crews.length) { console.log(T.noCrew); return null; }
  const w = want.trim().toLowerCase();
  let crew = w ? crews.find((c) => c.slug.toLowerCase() === w || String(c.name).toLowerCase() === w) : crews.find((c) => c.slug === cfg.crews?.[ws]);
  if (!crew && !w && crews.length === 1) crew = crews[0];
  if (!crew) { const i = await choose(T.crews, crews.map((c) => `${c.name}${c.role ? ` — ${c.role}` : ''}`)); crew = i >= 0 ? crews[i] : null; }
  if (crew) { cfg.crews = { ...(cfg.crews ?? {}), [ws]: crew.slug }; writeConfig({ crews: cfg.crews }); }
  return crew;
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

/* ─── 입구 — 대화 화면 ─── */
async function interactive() {
  if (!rl || !process.stdout.isTTY) { console.error(T.noTty); process.exit(1); }
  process.env.ARGO_NO_LEADER = '1'; // 대화 화면은 동기화만 — 실행 담당(메신저·루틴)은 맡지 않는다(argo run·/serve가 맡는다)
  // 코어 진단 로그("[argo] 동기화 시작…")는 대화 사이에 끼지 않게 ~/.argo/cli.log로(실측: 배너 위에 떴다). 1MB 넘으면 한 번 교체 — 쌓이기만 하지 않게.
  const { appendFileSync, statSync, renameSync, mkdirSync: mk } = await import('node:fs');
  const logFile = join(cliHome(), 'cli.log');
  try { mk(cliHome(), { recursive: true }); if (statSync(logFile).size > 1_000_000) renameSync(logFile, `${logFile}.1`); } catch { /* 없음 */ }
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { if (!isCoreLog(a[0])) return orig(...a); try { appendFileSync(logFile, `${new Date().toISOString()} ${k} ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}\n`, { mode: 0o600 }); } catch { /* 로그 실패는 무시 */ } };
  }
  const s = await requireSession({ interactive: true });
  const ws = await pickCompany(s.user.id, { interactive: true });
  const { ensureSync } = await import('../src/sync.mjs'); ensureSync(); // 여기서 한 대화가 앱에도 보이게
  const { readFileSync } = await import('node:fs');
  const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
  const company = (await ownCompanies(s.user.id)).find((c) => c.id === ws);
  console.log(`\n${banner({ cols: cols(), version, color }).join('\n')}\n`);
  console.log(dim(`  ${s.user.email ?? ''} · ${company?.name ?? ws}`));
  // 이 기기에 연결된 AI가 없으면 먼저 알린다 — 연결 정보는 기기마다 따로(클라우드 미동기, 유건 지시 2026-08-29)
  try {
    const { runnerStatus } = await import('../src/runners.mjs');
    const st = await runnerStatus(ws);
    if (!Object.values(st).some((v) => v?.company?.connected)) {
      console.log(`  ${T.noRunner}`);
      const host = Object.values(st).filter((v) => v?.hostUsable && !v?.hidden).map((v) => v.name).filter(Boolean);
      if (host.length) console.log(`  ${dim(T.hostAvail(host.join('·')))}`);
      console.log('');
    }
  } catch { /* 안내일 뿐 — 실패해도 대화는 연다 */ }
  let crew = await pickCrew(ws);
  const showCrew = () => console.log(`  ${crew ? T.talkingTo(bold(crew.name)) : T.noCrew}   ${dim(`·  ${T.headHint}`)}\n`);
  showCrew();
  const { loadThread, resetThread } = await import('../src/thread.mjs');
  const { interruptTurn } = await import('../src/turn-abort.mjs');
  let sid = crew ? (await loadThread(ws, crew.slug)).sessionId ?? null : null;
  const queue = [];
  onSigint = () => {
    // 순서는 Claude Code와 같다 — 친 글자가 있으면 그 줄만 지운다(답하는 중에도: 입력을 지우려다 턴을 멈추지 않게, 실측)
    if (rl.line) { rl.write(null, { ctrl: true, name: 'e' }); rl.write(null, { ctrl: true, name: 'u' }); return; }
    if (current) { // 답하는 중 — 그 턴만 멈춘다(앱의 멈춤과 같은 경로)
      if (!current.stopping) { current.stopping = true; interruptTurn(current.ws, current.slug, { tag: current.turnId }).catch(() => {}); }
      return;
    }
    process.stdout.write(`\n  ${dim(T.quitHint)}\n`); rl.prompt();
  };
  onQueuedLine = (l) => { // 입력 대기가 없을 때 친 줄 — 턴 사이 틈 포함(실측: 턴 실행 여부로 거르면 틈에 친 exit가 사라졌다).
    // 대기 중(question)일 때는 readline이 'line'을 내지 않는다(실측) — 두 번 처리되지 않는다.
    if (!l.trim()) return;
    queue.push(l); process.stdout.write(`\r\x1b[2K${dim(fit(`  › ${l.trim()}  (${T.queued})`, cols()))}\n`);
  };
  for (;;) {
    muted = false;
    const line = queue.length ? queue.shift() : await ask('› ');
    const p = parseInput(line);
    if (p.kind === 'empty') continue;
    if (p.kind === 'quit') { rl?.close(); process.exit(0); }
    if (p.kind === 'unknown') { console.log(`  ${dim(T.unknownCmd(p.name))}\n`); continue; }
    if (p.kind === 'command') {
      if (p.name === 'help') { console.log(''); for (const [k, d] of T.help) console.log(`  ${k}${' '.repeat(Math.max(1, 15 - termWidth(k)))}${dim(d)}`); console.log(''); }
      else if (p.name === 'crew') { const c = await pickCrew(ws, p.arg); if (c) { crew = c; sid = (await loadThread(ws, crew.slug)).sessionId ?? null; } showCrew(); }
      else if (p.name === 'new') { if (crew) { await resetThread(ws, crew.slug); sid = null; console.log(`  ${dim(T.newDone)}\n`); } }
      else if (p.name === 'hire') await hireCrew(ws);
      else if (p.name === 'ai') await runnersMenu(ws);
      else if (p.name === 'browser') await browserMenu({ interactive: true });
      else if (p.name === 'status') await status();
      else if (p.name === 'serve') { console.log(T.serveStart); onSigint = null; onQueuedLine = null; rl?.close(); rl = null; await runResident(); return; }
      continue;
    }
    if (!crew) { console.log(T.noCrew); continue; }
    muted = true; // 답하는 중 입력 반향을 막는다 — 친 줄은 대기열로 받는다(onQueuedLine)
    try { const t = await turn(ws, crew, p.text, sid); sid = t.sessionId ?? sid; }
    catch (e) { console.log(e?.aborted ? `  ${dim(T.stopped)}\n` : `  ${T.failed(cliHintText(String(e?.message || e).slice(0, 400)))}\n`); }
    finally { muted = false; }
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
    await chatLoop(ws, crew, rest.slice(1).join(' '));
    process.exit(0);
  } else { console.log(T.usage); process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1); }
} catch (e) {
  console.error(T.failed(String(e?.message || e)));
  process.exit(1);
}
