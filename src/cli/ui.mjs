// argo 대화 화면 조각 — 순수 함수만(테스트가 그대로 부른다). 색은 graphite 흑백: 굵게(1)·흐리게(2)만 쓰고 색상 코드는 쓰지 않는다.
// 심볼은 app/icon.svg의 돛·네 갈래 별 도형을 반블록 문자로 래스터화한 것(손그림 아님 — 비율이 원본과 같다).
import { OLD_CLI_COMMANDS } from '../legacy-terms.mjs'; // 옛 명령 이름(/crew) → 새 이름(/agent) — 옛 이름도 계속 받는다

const SYMBOL = [
  '       ▄████▄',
  '     ▄████████▄',
  '    ▄████▀▀████▄',
  '   ▄█████  █████▄',
  '  ██████▀  ▀██████',
  ' ████▀▀▀ ▄▄ ▀▀▀████',
  '      ▄▄▄██▄▄▄',
  '        ▀██▀',
  '         ▀▀',
];
const WORD = [
  ' █████  ██████   ██████   ██████',
  '██   ██ ██   ██ ██       ██    ██',
  '███████ ██████  ██   ███ ██    ██',
  '██   ██ ██   ██ ██    ██ ██    ██',
  '██   ██ ██   ██  ██████   ██████',
];
const SMALL = ['  ▄██▄', ' ▀▀▄▄▀▀', '   ▀▀'];

export const COMMANDS = ['help', 'agent', 'new', 'hire', 'ai', 'serve', 'browser', 'status', 'quit', 'exit'];
const ESC = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s) => [...String(s).replace(ESC, '')].length;
export const style = (color) => ({ bold: (s) => (color ? `\x1b[1m${s}\x1b[22m` : s), dim: (s) => (color ? `\x1b[2m${s}\x1b[22m` : s) });

/** 첫 화면 머리 — 60칸 이상이면 심볼 + ARGO 큰 글자, 좁으면 작은 심볼 + 한 줄. */
export function banner({ cols = 80, version = '', color = true } = {}) {
  const { bold, dim } = style(color);
  const ver = version ? `v${version}` : '';
  if (cols < 60) return SMALL.map((l, i) => (i === 1 ? `${bold(l)}   ${bold('ARGO')} ${dim(ver)}` : bold(l)));
  const right = ['', ...WORD.map(bold), '', dim(`${ver} · CLI`)];
  return SYMBOL.map((l, i) => (right[i] ? `${bold(l)}${' '.repeat(20 - l.length)}   ${right[i]}` : bold(l)));
}

/** 한 줄 입력 해석. 나가기는 /quit·/exit·exit·quit만(유건 결정 — Ctrl+C로는 나가지 않는다). */
export function parseInput(line) {
  const s = String(line ?? '').trim();
  if (!s) return { kind: 'empty' };
  if (/^\/?(quit|exit)$/i.test(s)) return { kind: 'quit' };
  if (s.startsWith('/')) {
    const [head, ...rest] = s.slice(1).split(/\s+/);
    if (head.includes('/')) return { kind: 'message', text: s }; // 경로(/Users/…)는 크루에게 보내는 말
    const typed = head.toLowerCase();
    const name = Object.hasOwn(OLD_CLI_COMMANDS, typed) ? OLD_CLI_COMMANDS[typed] : typed; // 옛 이름은 새 이름으로 읽는다
    return COMMANDS.includes(name) ? { kind: 'command', name, arg: rest.join(' ') } : { kind: 'unknown', name: head };
  }
  return { kind: 'message', text: s };
}

// 터미널 칸 폭 — 한글·한자·전각은 2칸(진행 줄이 줄바꿈되면 \r 덮어쓰기가 깨져 줄이 쌓인다).
const wide = (cp) => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
export const termWidth = (s) => [...String(s).replace(ESC, '')].reduce((n, ch) => n + (wide(ch.codePointAt(0)) ? 2 : 1), 0);
/** 색 없는 문자열을 cols칸 안으로 자른다(넘치면 …). */
export function fit(s, cols) {
  let out = ''; let w = 0;
  for (const ch of String(s)) { const cw = wide(ch.codePointAt(0)) ? 2 : 1; if (w + cw > cols - 1) return `${out}…`; out += ch; w += cw; }
  return out;
}

/** 에이전트 이름 비교용 모양 — 소문자, 글자·숫자만(대소문자·공백·-·_ 차이를 무시). */
const nameKey = (s) => String(s ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
function editDistance(a, b) {
  const x = [...a]; const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}
/** argo chat <이름>에서 이름을 틀리게 쓴 경우 "혹시 이 에이전트?"로 보여 줄 후보 — 이름(slug)·표시 이름과 오타 한두 글자 이내이거나 앞뒤 일부만 쓴 에이전트를 가까운 순으로 최대 max명.
    chat은 정확히 같은 이름만 받으니 대소문자만 다른 경우도 후보에 든다. 이름이 비었거나 비슷한 것이 없으면 빈 배열. */
export function similarAgents(want, crews, max = 3) {
  const w = nameKey(want); const len = [...w].length;
  if (!len) return [];
  const limit = Math.min(2, Math.max(1, Math.floor(len / 2)));
  return (crews ?? []).map((c) => {
    let best = Infinity;
    for (const key of [nameKey(c.slug), nameKey(c.name)]) {
      if (!key) continue;
      const near = (len >= 2 && key.includes(w)) || (key.length >= 3 && w.includes(key)); // 일부만 쓴 이름(nov → nova)·덧붙인 이름
      best = Math.min(best, key === w ? 0 : near ? 0.5 : editDistance(w, key));
    }
    return { c, best };
  }).filter((x) => x.best <= limit).sort((a, b) => a.best - b.best || String(a.c.slug).localeCompare(String(b.c.slug))).slice(0, max).map((x) => x.c);
}

/** 코어 모듈의 진단 로그인가 — "[argo] 동기화…", "[sync] …" 처럼 대괄호 접두. 대화 화면에서는 파일로 보낸다. */
export const isCoreLog = (first) => typeof first === 'string' && /^\[[a-z][\w-]*\]/i.test(first);
/** 앱 기준 안내(설정 → AI 연결)를 CLI 명령으로 바꿔 보인다 — 원문(앱·기록)은 그대로. */
export const cliHintText = (msg) => String(msg ?? '').replace(/설정 → AI 연결/g, '/ai').replace(/Settings → AI connections/g, '/ai');

/** 연결된 AI가 하나도 없을 때 "이 컴퓨터 로그인(host)"으로 자동 연결할 러너 — 키가 아니라 이 기기 로그인을 쓴다는 선택뿐이라
    기기 밖으로 나가는 것이 없다(연결 정보 기기별 원칙 유지). 이미 하나라도 연결돼 있으면 건드리지 않는다(사용자 선택 존중).
    hostUsable은 "이 방식을 쓸 수 있는 러너"일 뿐 로그인 여부가 아니다 — 실제 로그인이 확인된 것(detect.authed, 확인 불가 제외)만 고른다.
    (로그인 없는 서버에서 연결만 걸면 "러너 없음" 대신 인증 실패로 바뀔 뿐이다.) */
export function hostAutoConnect(status, detect = {}) {
  const all = Object.entries(status ?? {});
  if (all.some(([, v]) => v?.company?.connected)) return [];
  return all.filter(([id, v]) => v?.hostUsable && !v?.hidden && detect[id]?.authed && !detect[id]?.authUnknown).map(([id]) => id);
}

// 여러 줄 붙여넣기 — 터미널의 bracketed paste(ESC[200~ … ESC[201~) 안의 줄바꿈을 ⏎로 바꿔 readline이 줄마다 보내지 않게 한다
// (실측: 붙여넣은 두 줄이 턴 두 번이 됐다. Node readline은 붙여넣기 표지를 켜도 안의 \r을 그대로 제출한다). 보낼 때 ⏎ → \n.
export const PASTE_NL = '⏎';
const START = '\x1b[200~'; const END = '\x1b[201~';
const heldSuffix = (s, marker) => { for (let n = Math.min(marker.length - 1, s.length); n > 0; n--) if (marker.startsWith(s.slice(-n))) return n; return 0; };
/** 상태 있는 변환기 — push(문자열 조각) → readline에 넘길 문자열. 표지가 조각 경계에 걸리면 다음 조각까지 기다린다. */
export function pasteFilter() {
  let inPaste = false; let held = '';
  return (chunk) => {
    let s = held + chunk; held = ''; let out = '';
    for (;;) {
      const marker = inPaste ? END : START;
      const i = s.indexOf(marker);
      if (i < 0) { const keep = heldSuffix(s, marker); const seg = s.slice(0, s.length - keep); out += inPaste ? seg.replace(/\r\n|\r|\n/g, PASTE_NL) : seg; held = s.slice(s.length - keep); return out; }
      const seg = s.slice(0, i); out += inPaste ? seg.replace(/\r\n|\r|\n/g, PASTE_NL) : seg;
      s = s.slice(i + marker.length); inPaste = !inPaste;
    }
  };
}
export const unpaste = (line) => String(line ?? '').split(PASTE_NL).join('\n');
