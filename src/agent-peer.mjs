// 에이전트 프로세스의 로컬 API 직접 호출 차단 — "요청을 보낸 프로세스가 이 서버가 띄운 자손인가".
//
// 위협(PR #916 분리 검수 재현 2026-10-09): 에이전트 셸(SDK Bash·Codex exec·MCP 서버)은 사용자와 같은 OS 계정으로 돈다.
// 루프백 API는 쿠키 마커(argo-device=1, 상수)와 기기 세션 파일로 주인 신원을 주므로, 에이전트가 curl·python으로
// 결재를 자가 승인하고 루틴을 지우고 주인 직접 턴(ownerSeat)을 열 수 있었다. 요청 본문·헤더·쿠키는 에이전트가 전부
// 흉내 낼 수 있어 HTTP 층에서는 사람과 구별할 수 없다. 구별되는 것은 **연결의 상대 프로세스**뿐이다:
// 사람의 브라우저·데스크톱 웹뷰(macOS WebKit 네트워크 프로세스는 launchd 자식, 리눅스 WebKitGTK는 앱의 자식)·터미널의
// argo·curl은 이 서버의 자손이 아니고, 에이전트가 띄운 모든 것(CLI 러너 → Bash → curl/python/node/nc)은 자손이다.
//
// 한계(정직 표기): 부모가 먼저 끝나 자손 관계가 끊긴 프로세스는 이 판정 밖이다 — 같은 OS 계정의 에이전트를 완전히 가두는 것은
// OS 샌드박스(에이전트 셸의 네트워크·쓰기 제한)의 몫이다(후속). Windows는 프로세스 표를 싸게 볼 방법이 없어 이번에는 판정하지 않는다
// (권한 게이트의 셸 판정만 적용 — src/loopback-api.mjs).
// 비용: 연결(소켓)당 한 번만 판정하고 결과를 소켓에 묶는다(keep-alive 연결은 재사용). 자손이 하나도 없으면(에이전트 미실행) ps 한 번으로 끝난다.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';

const EXEC_TIMEOUT_MS = 2_000;

// 절대 경로 — 앱(Finder 실행)·launchd 상주의 PATH가 짧아도 같은 도구를 찾는다(macOS 기본 위치)
const BIN = { ps: '/bin/ps', lsof: '/usr/sbin/lsof' };
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(BIN[cmd] ?? cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    // lsof는 고른 프로세스에 맞는 소켓이 없으면 종료 코드 1로 끝난다 — 오류가 아니라 "없음"이다
    if (err && !(cmd === 'lsof' && err.code === 1)) return reject(err);
    resolve(String(stdout ?? ''));
  });
});

/** "pid ppid" 줄 목록 → root의 자손 pid 배열(순수). */
export function descendantsOf(root, pairs) {
  const kids = new Map();
  for (const [pid, ppid] of pairs) {
    if (!(pid > 0) || pid === ppid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = []; const seen = new Set([root]); const q = [root];
  while (q.length) for (const c of kids.get(q.shift()) ?? []) if (!seen.has(c)) { seen.add(c); out.push(c); q.push(c); }
  return out;
}

/** 주소 표기 정규화 — IPv4 매핑 IPv6(::ffff:127.0.0.1)·대괄호를 걷어 같은 주소를 같은 문자열로. */
export const normAddr = (a) => String(a ?? '').replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').toLowerCase();

/** lsof -F 출력에서 pid → 이 소켓 쌍(상대 쪽 local = peer, remote = 서버)을 가진 pid(순수). 없으면 0. */
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

/** /proc/net/tcp 본문에서 상대 쪽 소켓(local = peer, remote = 서버)의 inode(순수). 없으면 null. */
export function procInode(table, peer) {
  for (const line of String(table).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const l = procAddr(f[1]); const r = procAddr(f[2]);
    if (l.port === peer.port && r.port === peer.serverPort && normAddr(l.addr) === normAddr(peer.addr) && normAddr(r.addr) === normAddr(peer.serverAddr)) return f[9];
  }
  return null;
}

async function procPairs() {
  const pairs = [];
  for (const d of await readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const stat = await readFile(`/proc/${d}/stat`, 'utf8').catch(() => '');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '); // comm에 공백·괄호가 있을 수 있다 — 마지막 ')' 뒤부터 센다
    if (rest.length > 1) pairs.push([Number(d), Number(rest[1])]);
  }
  return pairs;
}

// 프로세스 표는 **연결을 처음 본 뒤에 찍은 것**만 나눠 쓴다(화면 첫 로드가 연결을 한꺼번에 열 때의 비용 절감). 연결 전에 찍은 표에는 방금 뜬
// 요청자(새 curl)가 없다 — 시간만 보고 재사용했더니 연달아 띄운 두 번째 curl이 통과했다(시험 실측 2026-10-09).
let descCache = null; // { at, pids: Promise<number[]> }
async function serverDescendants(platform, since) {
  if (descCache && descCache.at > since) return descCache.pids; // 같은 밀리초는 새로 찍는다 — 순서를 보장할 수 없다
  const now = Date.now();
  const pids = (async () => {
    const pairs = platform === 'linux' ? await procPairs()
      : (await run('ps', ['-A', '-o', 'pid=,ppid='])).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    return descendantsOf(process.pid, pairs);
  })();
  descCache = { at: now, pids };
  pids.catch(() => { if (descCache?.pids === pids) descCache = null; });
  return pids;
}

/** 이 연결의 상대가 이 서버의 자손 프로세스면 그 pid, 아니면 0. Windows·판정 실패는 0(fail-open — 로그만). */
export async function agentPeerPid(peer, { platform = process.platform, since = Date.now() } = {}) {
  if (platform === 'win32') return 0;
  const pids = await serverDescendants(platform, since);
  if (!pids.length) return 0;
  if (platform === 'linux') {
    const tables = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((f) => readFile(f, 'utf8').catch(() => '')));
    const inode = tables.map((t) => procInode(t, peer)).find(Boolean);
    if (!inode || inode === '0') return 0;
    const target = `socket:[${inode}]`;
    for (const pid of pids) {
      const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of fds) if ((await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')) === target) return pid;
    }
    return 0;
  }
  const out = await run('lsof', ['-nP', '-a', '-p', pids.join(','), `-iTCP:${peer.port}`, '-Fpn']);
  return lsofOwner(out, peer);
}

/** 판정 제외 — 신원 마커(/api/ping, 비밀 없음)와 정적 자산. 나머지(페이지·API·인증 경로)는 에이전트 자손이면 전부 거절한다 —
    자손 프로세스가 이 서버를 사람처럼 부를 정당한 경로는 없다(argo CLI·메신저 앱은 이 API를 부르지 않는다, 2026-10-09 전수 수색). */
export const peerCheckExempt = (url) => {
  const path = String(url ?? '').split('?')[0];
  return path === '/api/ping' || path.startsWith('/_next/static/') || path === '/favicon.ico';
};

const DENY = {
  ko: '에이전트 프로세스는 이 컴퓨터의 Argo API를 직접 부를 수 없습니다 — 결재·루틴·설정·대화 시작은 사람이 화면에서 하는 일입니다.',
  en: 'Agent processes cannot call this computer\'s Argo API directly — approvals, routines, settings and new chats are for a person using the app.',
};

const verdicts = new WeakMap(); // socket → Promise<pid> — 연결의 상대 프로세스는 연결이 끝날 때까지 바뀌지 않는다
const warned = new WeakSet();

/** 요청 하나를 판정해 거절했으면 true. 거절 응답(403 JSON, errorCode agent_loopback)까지 여기서 쓴다. */
export async function denyAgentPeer(req, res, opts = {}) {
  if (peerCheckExempt(req.url)) return false;
  const s = req.socket;
  if (!s?.remotePort) return false;
  let v = verdicts.get(s);
  if (!v) {
    v = agentPeerPid({ addr: s.remoteAddress, port: s.remotePort, serverAddr: s.localAddress, serverPort: s.localPort }, { since: Date.now(), ...opts })
      .catch((e) => { console.warn('[argo] 요청 상대 프로세스 판정 실패 — 이번 연결은 검사 없이 통과:', e?.code ?? e?.message ?? e); return 0; });
    verdicts.set(s, v);
  }
  const pid = await v;
  if (!pid) return false;
  if (!warned.has(s)) { warned.add(s); console.warn(`[argo] 에이전트 프로세스(pid ${pid})의 로컬 API 직접 호출 거절: ${req.method} ${String(req.url).split('?')[0]}`); }
  const lang = /(?:^|;\s*)argo-lang=en\b/.test(String(req.headers?.cookie ?? '')) ? 'en' : 'ko';
  req.resume?.(); // 본문은 읽어 버린다 — 연결이 막히지 않게
  if (!res.headersSent) res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: DENY[lang], errorCode: 'agent_loopback' }));
  return true;
}

/** 프로세스의 모든 HTTP 서버 요청 앞에 판정을 끼운다(멱등). Next는 서버 인스턴스를 내주지 않으므로 http.Server의 'request' 발행을 감싼다 —
    판정이 끝날 때까지 Next 핸들러 호출을 미루고, 본문 스트림은 그동안 읽히지 않은 채 버퍼에 남는다.
    같은 프로세스의 다른 서버(커넥터·러너 로그인 콜백)는 브라우저가 부르는 곳이라 자손이 아니고 판정 비용만 같다. */
export function installAgentPeerGuard() {
  if (globalThis.__argoAgentPeerGuard) return;
  globalThis.__argoAgentPeerGuard = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function guardedEmit(ev, req, res, ...rest) {
    if (ev !== 'request' || !req || !res) return emit.call(this, ev, req, res, ...rest);
    denyAgentPeer(req, res).then(
      (denied) => { if (!denied) emit.call(this, ev, req, res, ...rest); },
      () => emit.call(this, ev, req, res, ...rest),
    );
    return true;
  };
}
