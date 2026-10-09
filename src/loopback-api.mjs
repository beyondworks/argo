// 권한 게이트의 2차 방어 — 셸 명령이 이 컴퓨터의 Argo API(루프백)를 부르면 실행 전에 거절한다.
// 주 방어는 서버의 연결 상대 판정(src/agent-peer.mjs)이다. 이 판정은 그보다 앞에서 (1) 에이전트에게 왜 안 되는지 알려 우회 시도 대신
// 사용자에게 요청하게 하고 (2) 서버 판정이 사람으로 볼 수밖에 없는 경로(사람 쪽 프록시를 거치는 요청 등)의 리터럴 명령을 앞에서 거른다.
// ponytail: 정규식 판정이라 문자열을 쪼개 조립한 명령('127.0'+'.0.1')은 못 잡는다 — 그건 서버 판정이 받는다(재현 2026-10-09).
// 결재로 올리지 않고 거절한다: 사람이 승인해도 서버 판정이 같은 요청을 다시 거절하고, "에이전트가 결재 API를 부르는 것"을 결재로 허용하는 것 자체가 우회다.

import { networkInterfaces } from 'node:os';

/** 루프백 호스트 표기 — localhost·127/8·0.0.0.0·::1·IPv4 매핑·16진/10진/8진 표기. 단어 중간(예: x127.0.0.1y)은 제외. 이 컴퓨터의 네트워크 카드 주소도 같이 본다(hasLocalHost). */
const HOST_RE = /(?:^|[^\w.-])(?:localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|0x7f[0-9a-f]{6}|2130706433|0177(?:\.\d{1,4}){1,3}|\[?::(?:ffff:127(?:\.\d{1,3}){3}|1)\]?)(?![\w-])/i;

// 이 컴퓨터 네트워크 카드 주소(192.168.x 등) — 서버가 0.0.0.0에 묶이면 루프백 대신 이 주소로도 닿는다
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const localHostRes = () => Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.address)
  .map((i) => new RegExp(`(?:^|[^\\w.:-])\\[?${escapeRe(i.address.replace(/%.*$/, ''))}\\]?(?![\\w.-])`, 'i'));
const hasLocalHost = (cmd) => HOST_RE.test(cmd) || localHostRes().some((r) => r.test(cmd));

/** 명령에 루프백 호스트가 있으면 포트 후보(정수, 중복 없음, 최대 8개), 없으면 빈 배열(순수). URL의 :포트, nc 127.0.0.1 3001,
    python ('127.0.0.1', 3001)처럼 호스트와 포트가 떨어진 표기까지 받으려고 명령 안의 2~5자리 수를 전부 후보로 본다. */
export function loopbackPortCandidates(command) {
  const cmd = String(command ?? '');
  if (!hasLocalHost(cmd)) return [];
  const out = [];
  for (const m of cmd.matchAll(/(?<![\w.])(\d{2,5})(?![\w.])/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 65535 && !out.includes(n)) out.push(n);
    if (out.length >= 8) break;
  }
  return out;
}

const PROBE_TTL_MS = 60_000;
const probeCache = new Map(); // port → { at, argo: Promise<boolean> }

/** 그 포트에서 Argo 서버가 답하는가 — /api/ping의 신원 마커({ argo: true }, 비밀 없음). 실패·시간 초과는 false. */
export function probeArgoPort(port) {
  const hit = probeCache.get(port);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.argo;
  const argo = fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.argo === true).catch(() => false);
  probeCache.set(port, { at: Date.now(), argo });
  return argo;
}

// 아주 좁은 "언급" 허용목록 — 실행 능력이 없는 순수 텍스트 도구만. awk(system)·sed(e)·git(-c/별칭)·find(-exec)·perl 등 실행 가능한 것은 **제외**.
// 방침(재검수): 루프백 Argo 주소·포트가 보이면 **거절이 기본**. 아래 mention 규칙을 모두 만족할 때만 '언급'으로 통과한다. 확신 못 하면 거절(오탐은 안내로, 우회는 장치 붕괴).
const MENTION_TOOLS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'head', 'tail', 'wc', 'sort', 'less']);
const toolBasename = (tok) => tok.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

// 셸처럼 확신 있게 분해 못 하게 하는 위험 구조 — 하나라도 있으면 mention 아님(거절 쪽).
//  명령/프로세스 치환, 변수 확장(명령 이름 조립), heredoc, 주석, 줄 이음, fd/소켓 리다이렉트, eval/source/exec/.
const DANGER_RE = /\$\(|`|\$\{|\$[A-Za-z_]|<\(|>\(|<<|\\\r?\n|(?:^|\s)#|[<>]&|&>|\/dev\/(?:tcp|udp)\//;
const WORD_DANGER_RE = /(?:^|[\s;&|(])(?:eval|source|exec|\.|env|command|builtin|xargs)(?:$|[\s;&|)])/;

/** 따옴표를 존중해 단순 명령으로 쪼갠다(순수). 따옴표가 안 맞으면(확신 불가) null. */
export function splitSimpleCommands(command) {
  const cmd = String(command ?? '');
  const segs = []; let cur = ''; let q = null; // q: 열린 따옴표(' 또는 ")
  for (let i = 0; i < cmd.length; i += 1) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') { cur += c + (cmd[i + 1] ?? ''); i += 1; continue; } cur += c; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (cmd[i + 1] ?? ''); i += 1; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') { segs.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (q) return null; // 따옴표 안 맞음 — 확신 불가
  segs.push(cur);
  return segs.map((x) => x.trim()).filter(Boolean);
}

/** 명령이 "주소를 언급만 할 뿐 부르지 않는가"(순수). 규칙을 다 만족할 때만 true. */
export function isMereMention(command) {
  const cmd = String(command ?? '');
  if (DANGER_RE.test(cmd) || WORD_DANGER_RE.test(cmd)) return false;
  const segs = splitSimpleCommands(cmd);
  if (segs === null) return false; // 따옴표 불균형
  let sawTool = false;
  for (const seg of segs) {
    const first = seg.split(/\s+/)[0];
    if (first === undefined) continue;
    if (first.startsWith('>') || first.startsWith('<')) continue; // 리다이렉트만 있는 조각(앞 명령의 연속) — >,>> 파일 쓰기는 허용
    if (/^[A-Za-z_]\w*=/.test(first)) return false; // 대입 접두(LC_ALL=… 등)는 통과시키지 않는다(범위 최소화)
    if (!MENTION_TOOLS.has(toolBasename(first))) return false;
    sawTool = true;
  }
  return sawTool; // 도구가 하나도 없으면(리다이렉트뿐 등) 통과시키지 않는다
}

/** 셸 명령이 Argo 루프백 API를 **부르는가**(언급만 하는 게 아니라). ownPort = 이 서버의 포트(Next가 listen 뒤 process.env.PORT에 적는다) — 같으면 탐침 없이 참. */
export async function shellCallsArgoApi(command, { ownPort = Number(process.env.PORT) || 0, probe = probeArgoPort } = {}) {
  const cmd = String(command ?? '');
  const ports = loopbackPortCandidates(cmd);
  if (!ports.length) return false; // 루프백 주소 자체가 없음(그냥 숫자뿐 등)
  if (isMereMention(cmd)) return false; // 아주 좁은 '언급'만 통과(grep·echo·cat|grep·echo >> file 등)
  if (ownPort && ports.includes(ownPort)) return true;
  const hits = await Promise.all(ports.filter((p) => p >= 1024).map((p) => probe(p)));
  return hits.some(Boolean);
}

export const ARGO_API_SHELL_MSG = {
  ko: '이 명령은 이 컴퓨터에서 실행 중인 Argo 앱의 API를 직접 부릅니다. 결재 승인·루틴·설정·대화 시작은 사람이 화면에서 하는 일이라 에이전트는 이 API를 부를 수 없습니다. 다른 방법으로 우회하지 말고, 필요한 일을 사용자에게 요청하세요.',
  en: 'This command calls the API of the Argo app running on this computer. Approvals, routines, settings and new chats are for a person using the app, so agents cannot call this API. Do not work around this — ask the user to do it.',
};
