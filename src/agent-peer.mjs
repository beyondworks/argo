// 에이전트 프로세스의 로컬 API 직접 호출 차단 — "요청을 보낸 프로세스가 에이전트인가".
//
// 위협(PR #916 분리 검수 재현 2026-10-09): 에이전트 셸(SDK Bash·Codex exec·MCP 서버)은 사용자와 같은 OS 계정으로 돈다.
// 루프백 API는 쿠키 마커(argo-device=1, 상수)와 기기 세션 파일로 주인 신원을 주므로, 에이전트가 curl·python으로
// 결재를 자가 승인하고 루틴을 지우고 주인 직접 턴(ownerSeat)을 열 수 있었다. 요청 본문·헤더·쿠키는 에이전트가 전부
// 흉내 낼 수 있어 HTTP 층에서는 사람과 구별할 수 없다. 구별되는 것은 **연결의 상대 프로세스**뿐이다.
//
// 이것은 담장이 아니라 **방지턱(과속 방지)**이다 — 같은 OS 계정의 에이전트가 사람인 척 사람용 변경 라우트를 바로 호출하는 것을 어렵게 만든다.
// 확실한 통제는 OS 샌드박스(에이전트 셸의 네트워크·쓰기 제한)와 기동 비밀이고(후속), 이 판정은 그 전까지의 깊이 방어다.
//
// 판정(이 컴퓨터 안에서 온 연결만 — 원격·리버스 프록시 뒤 사용자는 이 컴퓨터의 프로세스가 아니다):
//  - 읽기(GET·HEAD·OPTIONS): 상대가 이 서버의 자손이면 거절. 판정 실패는 통과(읽기 화면이 도구 오류로 멈추지 않게).
//  - 변경(그 밖 메서드): 상대 프로세스를 전체 프로세스에서 찾아 아래 중 하나면 에이전트로 거절하고, **찾지 못하거나 판정이 실패하면
//    거절한다(fail-closed)** — "에이전트가 아님을 확인한 연결만" 결재·루틴·설정·대화 시작을 바꾼다.
//      ① 이 서버의 자손 ② 에이전트 표지 env(AGENT_MARK — 서버가 자기 env에 심어 모든 자식이 물려받는다)
//      ④ 그룹 우두머리가 이 서버·자손·표지 프로세스(agent-group) ⑥(macOS) launchd에 입양된 고아인데 실행 파일이 설치된 앱 묶음 밖(orphan-cli)
//    사람의 클라이언트는 이 중 어디에도 안 걸린다(관찰 2026-10-09: macOS WebKit 네트워크 프로세스·Argo 앱은 launchd 자식이고
//    실행 파일이 설치된 앱 묶음 안. 터미널 명령·파이프라인은 셸의 자식이라 고아가 아니다).
//  - 설계 조정(검수 반영): 옛 ③(그룹 우두머리 사망)·⑤(서버와 같은 그룹)은 제거했다. ③은 `echo … | cat | curl -d @-` 같은
//    사람 터미널 파이프라인을 오거절했고(맥은 ⑥, 리눅스는 ②가 에이전트 고아를 덮어 효과가 겹친다), ⑤는 서버를 띄운 부모(테스트 하네스·
//    smoke:standalone)를 오거절했다. ⑥은 ps가 주는 실행 파일 경로를 믿는데 **argv[0]·실행 파일 경로는 위장될 수 있다**(exec로 가짜 경로)
//    — 방지턱의 한 겹일 뿐이다.
//  - Windows: 기본 꺼짐(ARGO_AGENT_PEER_CHECK=on 옵트인). WebView2 실기·netstat 비용 확인 전이라 사람을 오거절하지 않도록 켜짐은 선택이다.
//    켜면 연결 소유 pid(netstat)의 실행 파일이 브라우저·웹뷰 목록일 때만 변경을 받는다.
//  - 리눅스: 다른 OS 계정의 소켓(리버스 프록시 등)은 위협 모델(같은 계정의 에이전트) 밖이라 통과.
// 남은 우회(정직 표기): 중간 프로세스를 살려 둔 이중 fork(그룹·표지를 사람 쪽으로 유지), argv[0]/실행 파일 경로 위장, osascript로 사람
// WKWebView를 몰아 호출, 리눅스에서 세션을 새로 만들고 표지 env까지 지운 고아(setsid + env -i). 근본 대책은 기동 비밀·OS 샌드박스(후속).
// 운영자 끄기: ARGO_AGENT_PEER_CHECK=off(부팅 때 읽음). Windows는 반대로 ARGO_AGENT_PEER_CHECK=on이어야 켜진다.
// 비용: 연결(소켓)·종류(읽기/변경)당 한 번 판정하고 소켓에 묶는다(keep-alive 재사용). 변경 판정은 새 연결마다 lsof·ps 각 1~2회(실측 median 107ms),
//   읽기 판정은 자손만 조회(실측 새 연결 +88ms, 캐시 히트는 0). 살아 있는 자식이 하나도 없으면(유휴) 읽기는 조회 없이 통과한다(trackChildren).
//   시간 캐시(1~2초)는 쓰지 않는다 — 표를 찍은 뒤 뜬 curl은 그 표에 없어서, 캐시가 사는 동안 그 curl의 읽기가 통과한다.
import http from 'node:http';
import { execFile, ChildProcess } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

export const AGENT_MARK = 'ARGO_AGENT_PROC';
// GET이지만 상태를 저장하는 라우트 — 변경처럼 fail-closed로 판정한다(검수 #4). OAuth 복귀 랜딩(브라우저 리다이렉트)이라 사람은 통과.
export const WRITE_ON_GET = new Set(['/auth/callback', '/auth/confirm']);
// 가드 제외 표시 — 같은 프로세스 안의 도구 중계 서버(src/engine/crew-mcp.mjs·browser-mcp.mjs)는 러너 CLI 자식(=서버 자손)이
// 정당하게 부르는 곳이다. 이 심볼을 http.Server에 달면 가드가 그 서버의 요청은 판정하지 않는다(HIGH-1: 중계 서버까지 403나 도구 전멸).
export const PEER_GUARD_EXEMPT = Symbol.for('argo.agentPeer.exempt');
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEC_TIMEOUT_MS = 5_000;

// 절대 경로 — 앱(Finder 실행)·launchd 상주의 PATH가 짧아도 같은 도구를 찾는다(macOS 기본 위치). Windows 도구는 System32(PATH).
const BIN = { ps: '/bin/ps', lsof: '/usr/sbin/lsof' };
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(BIN[cmd] ?? cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    // lsof는 맞는 소켓이 없으면 종료 코드 1 — 오류가 아니라 "없음"이다(호출부가 없음을 판정한다)
    if (err && !(cmd === 'lsof' && err.code === 1)) return reject(err);
    resolve(String(stdout ?? ''));
  });
});

// 살아 있는 자식 프로세스 수 — 자손은 살아 있는 자식 밑에만 있으므로(부모가 죽은 손주는 launchd·init에 입양돼 자손이 아니다) 0이면 읽기 판정의
// ps 조회(실측 중앙값 50ms, 새 연결마다)를 건너뛴다. 유휴 상주는 자손 0(관찰 2026-10-10, :3001). child_process의 spawn·exec·execFile·fork는
// 모두 ChildProcess.prototype.spawn을 지나 여기서 센다. spawnSync는 끝날 때까지 이벤트 루프를 막아 그동안 요청이 없다.
// 판정 자신의 ps·lsof도 끝날 때까지는 센다 — 그동안 들어온 읽기가 조회를 한 번 더 할 뿐이다.
// ponytail: worker_threads 안에서 띄운 자식과 네이티브 애드온(node-pty 등)의 fork는 못 센다 — 지금 그런 경로 없음(grep). 놓쳐도 읽기만 통과(읽기는 원래 fail-open), 변경은 아래 classifyPeer 그대로.
const kids = { tracking: false, live: 0 };
function trackChildren() {
  if (kids.tracking) return;
  kids.tracking = true;
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function trackedSpawn(...args) {
    const r = spawn.apply(this, args);
    if (this.pid) { kids.live++; this.once('exit', () => { kids.live--; }); }
    return r;
  };
}
/** 읽기 조회를 건너뛰어도 되는가(순수). 서버가 PID 1(컨테이너에서 `node server.js`를 init 없이)이면 부모가 끝난 손주가 서버 밑으로
    입양돼 자식 수 밖의 자손이 된다 — 그때는 건너뛰지 않는다(검수 #920 재현: node:22 컨테이너에서 고아 GET 200). */
export const readSkipOk = ({ tracking, live, pid }) => tracking && live === 0 && pid !== 1;
/** 판정이 센 살아 있는 자식 수(시험·진단용). 추적 전이면 null. */
export const liveChildCount = () => (kids.tracking ? kids.live : null);

/* ─── 순수 판정 재료 ─────────────────────────────────────────────────────── */

/** [pid, ppid] 목록 → root의 자손 pid 집합(순수). */
export function descendantsOf(root, pairs) {
  const kids = new Map();
  for (const [pid, ppid] of pairs) {
    if (!(pid > 0) || pid === ppid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = new Set(); const q = [root];
  while (q.length) for (const c of kids.get(q.shift()) ?? []) if (c !== root && !out.has(c)) { out.add(c); q.push(c); }
  return out;
}

/** 주소 표기 정규화 — IPv4 매핑 IPv6(::ffff:127.0.0.1)·대괄호·영역 표시(%en0)를 걷어 같은 주소를 같은 문자열로. */
export const normAddr = (a) => String(a ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase();

/** 이 컴퓨터의 주소인가(루프백·자기 네트워크 카드 주소). 서버가 0.0.0.0에 묶이면 에이전트가 192.168.x로 붙을 수 있다. */
export function isLocalAddr(addr, ifaces = networkInterfaces()) {
  const a = normAddr(addr);
  if (!a) return false;
  if (/^127\./.test(a) || a === '::1' || a === '0.0.0.0' || a === '::') return true;
  return Object.values(ifaces).flat().some((i) => i && normAddr(i.address) === a);
}

// 파서 차이(parser-differential) 방어: 어느 프로세스인지의 **권위는 커널이 준 연결 4요소**(req.socket의 remote/local 주소·포트)다.
// 아래 파서들은 그 4요소와 **정확히** 일치하는 소켓 줄만 pid로 매핑한다 — 출력이 로캘·공백·IPv6 표기·여러 줄·잘림으로 흔들려도
// 일치가 안 되면 pid를 주지 않고(=0/null), 그러면 변경 라우트는 fail-closed로 거절한다. ephemeral 로컬 포트가 연결마다 달라 4요소는 유일하다.
/** lsof -F 출력 → 이 소켓 쌍(상대 쪽 local = 요청자, remote = 서버)을 가진 pid(순수). 없으면 0. */
export function lsofOwner(out, peer) {
  let pid = 0;
  for (const line of String(out).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') {
      const m = /^(.*):(\d+)->(.*):(\d+)$/.exec(line.slice(1));
      if (m && Number(m[2]) === peer.port && Number(m[4]) === peer.serverPort
        && normAddr(m[1]) === normAddr(peer.addr) && normAddr(m[3]) === normAddr(peer.serverAddr)) return pid;
    }
  }
  return 0;
}

/** /proc/net/tcp{,6} 주소 칸(HEX:PORT) → { addr, port }(순수). 커널은 32비트 단어를 호스트 바이트 순서(리틀 엔디언)로 적는다. */
export function procAddr(field) {
  const [hex, p] = String(field).split(':');
  const port = parseInt(p, 16);
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => w.match(/../g).reverse().map((b) => parseInt(b, 16)));
  if (bytes.length === 4) return { addr: bytes.join('.'), port };
  if (bytes.length === 16 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return { addr: bytes.slice(12).join('.'), port };
  if (bytes.length === 16 && bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return { addr: '::1', port };
  const groups = []; for (let i = 0; i < bytes.length; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return { addr: groups.join(':'), port };
}

/** /proc/net/tcp 본문 → 상대 쪽 소켓(local = 요청자, remote = 서버)의 { inode, uid }(순수). 없으면 null. */
export function procSocket(table, peer) {
  for (const line of String(table).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const l = procAddr(f[1]); const r = procAddr(f[2]);
    if (l.port === peer.port && r.port === peer.serverPort && normAddr(l.addr) === normAddr(peer.addr) && normAddr(r.addr) === normAddr(peer.serverAddr)) return { inode: f[9], uid: Number(f[7]) };
  }
  return null;
}

/** netstat -ano 출력 → 상대 쪽 소켓 소유 pid(순수, Windows). 상태 낱말은 언어마다 달라 보지 않고 마지막 칸을 pid로 읽는다. */
export function netstatOwner(out, peer) {
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== 'TCP' || f.length < 4) continue;
    const l = /^(.*):(\d+)$/.exec(f[1]); const r = /^(.*):(\d+)$/.exec(f[2]);
    if (l && r && Number(l[2]) === peer.port && Number(r[2]) === peer.serverPort && normAddr(l[1]) === normAddr(peer.addr) && normAddr(r[1]) === normAddr(peer.serverAddr)) return Number(f.at(-1)) || 0;
  }
  return 0;
}

/** Windows에서 변경을 받는 클라이언트 — 데스크톱 앱 웹뷰(WebView2)와 주요 브라우저의 실행 파일. */
export const WIN_HUMAN_IMAGES = new Set(['msedgewebview2.exe', 'msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'whale.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'chromium.exe', 'iexplore.exe']);

/** 유닉스 판정(순수). table: pid → { ppid, pgid, exe? }(exe는 macOS만), marked: 표지 env가 보인 pid 집합.
    반환 { agent: boolean, reason }. pid가 표에 없으면 판정 불가로 던진다(호출부가 변경을 거절한다). */
export function judgePeer({ self, pid, table, marked = new Set(), home = process.env.HOME ?? '' }) {
  if (pid === self) return { agent: false, reason: 'self' };
  const row = table.get(pid);
  if (!row) throw Object.assign(new Error('peer not in process table'), { code: 'PEER_GONE' });
  const desc = descendantsOf(self, [...table].map(([p, r]) => [p, r.ppid]));
  if (desc.has(pid)) return { agent: true, reason: 'descendant' };
  if (marked.has(pid)) return { agent: true, reason: 'marked' };
  // ④ 그룹 우두머리가 서버·자손·표지면 에이전트(살아 있는 에이전트 그룹의 고아). 우두머리가 표에 없으면(죽음) 사람 파이프라인일 수도
  //    있어(옛 ③은 제거) 여기서 판정하지 않는다 — 맥은 ⑥, 리눅스는 ②가 그 고아를 덮는다.
  const leader = row.pgid;
  if (leader !== pid && table.has(leader) && (leader === self || desc.has(leader) || marked.has(leader))) return { agent: true, reason: 'agent-group' };
  // ⑥ macOS: launchd에 입양된 고아(ppid 1)인데 실행 파일이 설치된 앱 묶음 밖 — 세션을 새로 만들고 시스템 실행 파일(env가 안 보인다)로 부른 셸 도구.
  //    사람 쪽 고아는 앱(브라우저·웹뷰·Argo)뿐이다. 터미널 명령·파이프라인은 셸의 자식이라 고아가 아니다. exe가 없으면(리눅스 표) 건너뛴다.
  //    ⚠ exe 경로는 위장될 수 있다(exec로 가짜 경로) — 방지턱의 한 겹.
  if (row.ppid === 1 && typeof row.exe === 'string' && !isInstalledAppExe(row.exe, home)) return { agent: true, reason: 'orphan-cli' };
  return { agent: false, reason: 'human' };
}

/** 설치된 앱 묶음 안의 실행 파일인가(macOS) — /Applications·/System·/Library/Apple·~/Applications 아래 .app·.xpc. */
export const isInstalledAppExe = (exe, home = process.env.HOME ?? '') => {
  const roots = ['/Applications/', '/System/', '/Library/Apple/', ...(home ? [`${home.replace(/\/$/, '')}/Applications/`] : [])];
  return roots.some((r) => exe.startsWith(r)) && /\.(?:app|xpc)\//.test(exe);
};

/* ─── 플랫폼별 조회 ─────────────────────────────────────────────────────── */

// macOS 표: pid ppid pgid 실행 파일 경로(comm — 공백이 들어갈 수 있어 나머지 전부)
const MAC_PS = ['-A', '-o', 'pid=,ppid=,pgid=,comm='];
const parseTable = (out) => {
  const t = new Map();
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/.exec(l);
    if (m && Number(m[1]) > 0) t.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), ...(m[4] ? { exe: m[4].trim() } : {}) });
  }
  return t;
};

async function procTable() {
  const t = new Map();
  for (const d of await readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = await readFile(`/proc/${d}/stat`, 'utf8').catch(() => '');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // comm에 공백·괄호가 있을 수 있다 — 마지막 ')' 뒤부터 센다
    if (rest.length > 2) t.set(Number(d), { ppid: Number(rest[1]), pgid: Number(rest[2]) });
  }
  return t;
}

async function procOwner(peer, pids) {
  const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'utf8').catch(() => '')));
  const sock = tables.map((t) => procSocket(t, peer)).find(Boolean);
  if (!sock || sock.inode === '0') return { pid: 0 };
  if (typeof process.getuid === 'function' && sock.uid !== process.getuid()) return { pid: 0, otherUser: true };
  const target = `socket:[${sock.inode}]`;
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
    for (const fd of fds) if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === target) return { pid };
  }
  return { pid: 0 };
}

const markLine = (s, keys = [AGENT_MARK]) => keys.some((k) => s.includes(`${k}=`));
async function markedAmong(platform, pids, keys = [AGENT_MARK]) {
  const out = new Set();
  const list = [...new Set(pids.filter((p) => p > 0))];
  if (!list.length) return out;
  if (platform === 'linux') {
    for (const p of list) if (markLine((await readFile(`/proc/${p}/environ`, 'utf8').catch(() => '')).split('\0').join(' '), keys)) out.add(p);
    return out;
  }
  // macOS: 같은 계정 프로세스의 env는 ps -E로 보인다. 시스템 실행 파일(/usr/bin/curl 등)은 env가 가려진다(실측) — 그래서 표지는 여러 근거 중 하나다.
  const res = await run('ps', ['-E', '-ww', '-o', 'pid=,command=', '-p', list.join(',')]).catch(() => '');
  for (const l of res.split('\n')) { const m = /^\s*(\d+)\s(.*)$/.exec(l); if (m && markLine(m[2], keys)) out.add(Number(m[1])); }
  return out;
}

/** 이 프로세스의 조상 중 에이전트 표지 env(AGENT_MARK·ARGO_AGENT_TURN)가 보이는 프로세스의 pid, 없으면 0 — argo office CLI·MCP의 자기 판정.
    에이전트 셸은 자기 env의 표지를 지울 수 있지만(unset·env -u) 이미 떠 있는 조상(러너·서버)의 env는 못 바꾼다. 셸 문자열 판정(따옴표·sh -c로 우회)보다 한 겹 더 단단하다.
    macOS는 시스템 실행 파일(/bin/sh 등)의 env가 ps -E에 안 보이지만, 그 위의 러너(node·claude·codex)와 서버는 보인다.
    남은 우회(정직 표기): 조상과의 연결을 끊은 고아(이중 fork 뒤 부모 종료 → ppid 1) — agent-peer 머리말의 같은 한계, 근본 대책은 OS 샌드박스(후속).
    Windows는 판정하지 않는다(0). 판정 실패는 던진다 — 호출부가 거절한다(fail-closed). */
export async function markedAncestor({ pid = process.pid, platform = process.platform, keys = [AGENT_MARK, 'ARGO_AGENT_TURN'] } = {}) {
  if (platform === 'win32') return 0;
  const table = platform === 'linux' ? await procTable() : parseTable(await run('ps', MAC_PS));
  if (!table.has(pid)) throw Object.assign(new Error('self not in process table'), { code: 'SELF_GONE' });
  const chain = [];
  for (let p = table.get(pid).ppid; p > 1 && table.has(p) && !chain.includes(p); p = table.get(p).ppid) chain.push(p);
  if (!chain.length) return 0;
  const marked = await markedAmong(platform, chain, keys);
  return chain.find((p) => marked.has(p)) ?? 0;
}

/** 읽기용 가벼운 판정 — 상대가 이 서버의 자손이면 그 pid, 아니면 0. 실패는 0(읽기는 fail-open). */
export async function descendantPeerPid(peer, { platform = process.platform } = {}) {
  if (platform === 'win32') return 0;
  const table = platform === 'linux' ? await procTable() : parseTable(await run('ps', MAC_PS));
  const desc = descendantsOf(process.pid, [...table].map(([p, r]) => [p, r.ppid]));
  if (!desc.size) return 0;
  if (platform === 'linux') return (await procOwner(peer, [...desc])).pid;
  return lsofOwner(await run('lsof', ['-nP', '-a', '-p', [...desc].join(','), `-iTCP:${peer.port}`, '-Fpn']), peer);
}

/** 변경용 판정 — { agent, reason, pid }. 판정할 수 없으면 던진다(호출부가 거절한다 — fail-closed). */
export async function classifyPeer(peer, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const pid = netstatOwner(await run('netstat', ['-ano']), peer);
    if (!pid) throw Object.assign(new Error('peer socket owner not found'), { code: 'PEER_UNKNOWN' });
    if (pid === process.pid) return { agent: false, reason: 'self', pid };
    const csv = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const image = (/^"([^"]+)"/m.exec(csv)?.[1] ?? '').toLowerCase();
    if (!image) throw Object.assign(new Error('peer image not found'), { code: 'PEER_UNKNOWN' });
    return WIN_HUMAN_IMAGES.has(image) ? { agent: false, reason: 'browser', pid } : { agent: true, reason: `image:${image}`, pid };
  }
  const table = platform === 'linux' ? await procTable() : parseTable(await run('ps', MAC_PS));
  let pid = 0;
  if (platform === 'linux') {
    const o = await procOwner(peer, [...table.keys()]);
    if (o.otherUser) return { agent: false, reason: 'other-user', pid: 0 };
    pid = o.pid;
  } else {
    pid = lsofOwner(await run('lsof', ['-nP', `-iTCP:${peer.port}`, '-Fpn']), peer);
  }
  if (!pid) throw Object.assign(new Error('peer socket owner not found'), { code: 'PEER_UNKNOWN' });
  if (pid === process.pid) return { agent: false, reason: 'self', pid };
  const row = table.get(pid) ?? (platform === 'linux' ? (await procTable()).get(pid) : parseTable(await run('ps', ['-o', 'pid=,ppid=,pgid=,comm=', '-p', String(pid)]).catch(() => '')).get(pid));
  if (row && !table.has(pid)) table.set(pid, row); // 표를 찍은 뒤 뜬 요청자 — 그 행만 보태 판정한다
  const marked = await markedAmong(platform, [pid, row?.pgid ?? 0]);
  return { ...judgePeer({ self: process.pid, pid, table, marked }), pid };
}

/* ─── 요청 앞 판정 ─────────────────────────────────────────────────────── */

/** 판정 제외 — 신원 마커(/api/ping, 비밀 없음)와 정적 자산. */
export const peerCheckExempt = (url) => {
  const path = String(url ?? '').split('?')[0];
  return path === '/api/ping' || path.startsWith('/_next/static/') || path === '/favicon.ico';
};

const MSG = {
  agent_loopback: {
    ko: '에이전트 프로세스는 이 컴퓨터의 Argo API를 직접 부를 수 없습니다 — 결재·루틴·설정·대화 시작은 사람이 화면에서 하는 일입니다.',
    en: 'Agent processes cannot call this computer\'s Argo API directly — approvals, routines, settings and new chats are for a person using the app.',
  },
  agent_check_failed: {
    ko: '요청한 프로그램을 확인하지 못해 변경을 막았습니다. Argo 앱이나 브라우저에서 다시 시도해 주세요.',
    en: 'Could not verify which program sent this request, so the change was blocked. Please try again from the Argo app or your browser.',
  },
};

// 판정 캐시는 **소켓 객체**(열려 있는 TCP 연결)에 묶는다. 한 연결이 사는 동안 상대 프로세스는 바뀌지 않으므로 keep-alive 재요청은 안전하게 재사용하고,
// 연결이 닫히면 WeakMap 항목이 GC된다. 새 연결 = 새 소켓 객체 = 새 판정이라 PID 재사용(옛 pid를 다른 프로세스가 물려받음)에도 옛 판정을 쓰지 않는다.
const verdicts = new WeakMap(); // socket → { read?: Promise, write?: Promise }
const warned = new WeakSet();

const deny = (req, res, code, detail) => {
  const s = req.socket;
  if (s && !warned.has(s)) { warned.add(s); console.warn(`[argo] 로컬 API 요청 거절(${code}${detail ? `, ${detail}` : ''}): ${req.method} ${String(req.url).split('?')[0]}`); }
  const lang = /(?:^|;\s*)argo-lang=en\b/.test(String(req.headers?.cookie ?? '')) ? 'en' : 'ko';
  req.resume?.(); // 본문은 읽어 버린다 — 연결이 막히지 않게
  if (!res.headersSent) res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: MSG[code][lang], errorCode: code }));
  return true;
};

/** 요청 하나를 판정해 거절했으면 true(403 응답까지 여기서 쓴다). opts.platform·opts.classify·opts.descendant는 시험용 주입. */
export async function denyAgentPeer(req, res, opts = {}) {
  if (peerCheckExempt(req.url)) return false;
  if ((opts.platform ?? process.platform) === 'win32' && String(process.env.ARGO_AGENT_PEER_CHECK ?? '').toLowerCase() !== 'on') return false; // Windows는 옵트인(기본 꺼짐)
  // GET이지만 상태(기기 세션)를 저장하는 OAuth 복귀 경로는 변경으로 판정한다(fail-closed) — 사람 브라우저의 복귀(토큰이 유효)는 자손이 아니라 통과하고,
  // 에이전트는 토큰을 위조 못 해도 이 경로를 GET으로 때릴 수 있으니 판정 대상에 넣는다. 데스크톱 앱 로그인은 다른 경로(/auth/paired·/api/auth/pair/*)라 영향 없다.
  const path = String(req.url ?? '').split('?')[0];
  const write = !SAFE_METHODS.has(String(req.method ?? 'GET').toUpperCase()) || WRITE_ON_GET.has(path);
  const s = req.socket;
  if (!s?.remotePort) return write ? deny(req, res, 'agent_check_failed', 'no-socket') : false;
  const peer = { addr: s.remoteAddress, port: s.remotePort, serverAddr: s.localAddress, serverPort: s.localPort };
  if (!isLocalAddr(peer.addr)) return false; // 원격(클라우드·리버스 프록시 뒤 사용자) — 이 컴퓨터의 프로세스가 아니다
  let slot = verdicts.get(s); if (!slot) { slot = {}; verdicts.set(s, slot); }
  if (!write) {
    if (!opts.descendant && readSkipOk({ ...kids, pid: process.pid })) return false; // 자식이 없으면 자손도 없다 — ps 없이 통과(판정을 소켓에 묶지 않는다: 같은 연결의 다음 요청 때 자식이 생겼을 수 있다)
    slot.read ??= (opts.descendant ?? descendantPeerPid)(peer, opts)
      .catch((e) => { console.warn('[argo] 요청 상대 프로세스 판정 실패(읽기 — 통과):', e?.code ?? e?.message ?? e); return 0; });
    const pid = await slot.read;
    return pid ? deny(req, res, 'agent_loopback', `pid ${pid}`) : false;
  }
  slot.write ??= (opts.classify ?? classifyPeer)(peer, opts).catch((e) => ({ error: e }));
  const v = await slot.write;
  if (v.error) return deny(req, res, 'agent_check_failed', v.error?.code ?? String(v.error?.message ?? v.error).slice(0, 80));
  return v.agent ? deny(req, res, 'agent_loopback', `pid ${v.pid} ${v.reason}`) : false;
}

/** 프로세스의 모든 HTTP 서버 요청 앞에 판정을 끼운다(멱등). Next는 서버 인스턴스를 내주지 않으므로 http.Server의 'request' 발행을 감싼다 —
    판정이 끝날 때까지 Next 핸들러 호출을 미루고, 본문 스트림은 그동안 읽히지 않은 채 버퍼에 남는다.
    같은 프로세스의 다른 서버(커넥터·러너 로그인 콜백)는 브라우저가 부르는 곳이라 같은 판정을 통과한다.
    에이전트 표지 env를 이 프로세스에 심는다 — 이후 이 서버가 띄우는 모든 자식(러너·셸·MCP)이 물려받는다(러너 env는 process.env 사본). */
export function installAgentPeerGuard(env = process.env) {
  if (globalThis.__argoAgentPeerGuard) return;
  globalThis.__argoAgentPeerGuard = true;
  const flag = String(env.ARGO_AGENT_PEER_CHECK ?? '').toLowerCase();
  if (flag === 'off') { console.warn('[argo] ARGO_AGENT_PEER_CHECK=off — 에이전트 프로세스의 로컬 API 호출 판정을 끔'); return; }
  if (process.platform === 'win32' && flag !== 'on') { console.warn('[argo] Windows에서는 에이전트 프로세스 판정이 기본 꺼짐 — 켜려면 ARGO_AGENT_PEER_CHECK=on'); return; } // 요청마다 async 훅을 걸지 않는다
  env[AGENT_MARK] = String(process.pid);
  trackChildren();
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function guardedEmit(ev, req, res, ...rest) {
    if (ev !== 'request' || !req || !res || this[PEER_GUARD_EXEMPT]) return emit.call(this, ev, req, res, ...rest); // 중계 서버(crew/browser MCP)는 제외
    denyAgentPeer(req, res).then(
      (denied) => { if (!denied) emit.call(this, ev, req, res, ...rest); },
      (e) => { // 판정 코드 자체의 예외 — 변경은 거절, 읽기는 통과(위 규칙과 같다)
        if (SAFE_METHODS.has(String(req.method ?? 'GET').toUpperCase())) emit.call(this, ev, req, res, ...rest);
        else deny(req, res, 'agent_check_failed', String(e?.message ?? e).slice(0, 80));
      },
    );
    return true;
  };
}
