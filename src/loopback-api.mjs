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

// 네트워크 호출 도구가 명령에 쓰였는가 — 이게 있어야 "루프백 포트를 **부르는**" 것이다.
// 이 조건이 없으면 `grep -rn "localhost:3001" src`·`echo "…http://localhost:3001…" >> README.md`처럼 주소를 **언급만** 하는 정상 명령이 오탐된다(검수 MED).
// 도구: curl·wget·nc/ncat/netcat·httpie(http/https)·그리고 인터프리터(python/node/ruby/perl/php/deno/bun)의 http 호출 흔적(urllib·requests·http.client·fetch·net.·httplib·LWP·Net::HTTP 등).
// httpie는 `http`/`https` 명령으로도 불린다 — 단, URL의 `http://`·`https://`는 도구가 아니므로 뒤에 `://`가 오면 제외한다(검수 MED 오탐).
const NET_TOOL_RE = /(?:^|[\s;&|(`"'=])(?:sudo\s+)?(?:\\|(?:\/usr(?:\/local)?)?\/s?bin\/)?(?:curl|wget|nc|ncat|netcat|telnet|socat|xh|httpie|https?(?!:?\/\/))\b/i;
const INTERP_HTTP_RE = /\b(?:python3?|node|nodejs|ruby|perl|php|deno|bun|osascript)\b[\s\S]*?(?:urllib|requests\.|http\.client|httplib|httpx|\bfetch\s*\(|net\.(?:connect|createConnection|Socket)|http\.(?:get|request)|https\.(?:get|request)|LWP|Net::HTTP|HTTParty|open-uri|URLSession|NSURL|curl)/i;
const callsNetwork = (cmd) => NET_TOOL_RE.test(cmd) || INTERP_HTTP_RE.test(cmd);

/** 셸 명령이 Argo 루프백 API를 **부르는가**(언급만 하는 게 아니라). ownPort = 이 서버의 포트(Next가 listen 뒤 process.env.PORT에 적는다) — 같으면 탐침 없이 참. */
export async function shellCallsArgoApi(command, { ownPort = Number(process.env.PORT) || 0, probe = probeArgoPort } = {}) {
  const cmd = String(command ?? '');
  if (!callsNetwork(cmd)) return false; // 네트워크 도구가 없으면 호출이 아니다(grep·echo·주석 등 언급은 통과)
  const ports = loopbackPortCandidates(cmd);
  if (!ports.length) return false;
  if (ownPort && ports.includes(ownPort)) return true;
  const hits = await Promise.all(ports.filter((p) => p >= 1024).map((p) => probe(p)));
  return hits.some(Boolean);
}

export const ARGO_API_SHELL_MSG = {
  ko: '이 명령은 이 컴퓨터에서 실행 중인 Argo 앱의 API를 직접 부릅니다. 결재 승인·루틴·설정·대화 시작은 사람이 화면에서 하는 일이라 에이전트는 이 API를 부를 수 없습니다. 다른 방법으로 우회하지 말고, 필요한 일을 사용자에게 요청하세요.',
  en: 'This command calls the API of the Argo app running on this computer. Approvals, routines, settings and new chats are for a person using the app, so agents cannot call this API. Do not work around this — ask the user to do it.',
};
