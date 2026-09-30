// argo 대화 화면 조각 — 순수 함수만(테스트가 그대로 부른다). 색은 graphite 흑백: 굵게(1)·흐리게(2)만 쓰고 색상 코드는 쓰지 않는다.
// 심볼은 app/icon.svg의 돛·네 갈래 별 도형을 반블록 문자로 래스터화한 것(손그림 아님 — 비율이 원본과 같다).
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

export const COMMANDS = ['help', 'crew', 'new', 'hire', 'ai', 'serve', 'browser', 'status', 'quit', 'exit'];
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
    const name = head.toLowerCase();
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
