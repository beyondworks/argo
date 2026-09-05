// 컴퓨터 유즈(네이티브 엔진 내장) — 화면 캡처와 마우스·키보드 입력. OpenClaw cua-computer(left_click·double_click·right_click·mouse_move·drag·scroll·type·key·screenshot)와
// 같은 동작 집합. 의존성 0 — 운영체제 도구만 쓴다: macOS = screencapture + sips(축소) + osascript(JXA로 CoreGraphics 이벤트·System Events 키),
// Windows = PowerShell(System.Drawing 캡처, user32 입력), Linux = xdotool + import(ImageMagick). 권한이 없으면(맥 접근성·화면 기록) 정직한 안내를 돌려준다.
// 러너·모델과 무관하게 같은 도구·같은 게이트(하네스 통일 — 유건 요구 2026-09-05 "컴퓨터 유즈도 아르고 하네스로").
import { execFile } from 'node:child_process';
import { readFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const COMPUTER_SPECS = Object.freeze([
  { name: 'computer_screenshot', description: 'Screenshot of the whole screen (downscaled to max 1280px wide). Returned as an image when the model supports vision; the file is also saved under vault/screenshots/. Coordinates for other computer_* tools are in this screenshot\'s pixel space unless scale is reported.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'computer_move', description: 'Move the mouse to screen coordinates (x, y).', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'computer_click', description: 'Left-click at (x, y). button: left | right | double.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'double'] } }, required: ['x', 'y'] } },
  { name: 'computer_drag', description: 'Drag with the left button from (x1, y1) to (x2, y2).', input_schema: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'computer_type', description: 'Type text at the current focus (unicode-safe).', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'computer_key', description: 'Press a key or combination: "enter", "tab", "escape", "cmd+c", "ctrl+shift+t", "alt+f4"…', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'computer_scroll', description: 'Scroll at (x, y): dy lines (positive = down), dx columns.', input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, dy: { type: 'number' }, dx: { type: 'number' } }, required: ['dy'] } },
]);

const run = (file, args, opts = {}) => new Promise((res, rej) => execFile(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...opts }, (e, out, err) => (e ? rej(Object.assign(new Error(String(err || e.message).trim().slice(0, 400)), { cause: e })) : res(String(out)))));
const num = (v, name) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${name} must be a number`); return Math.round(n); };

// ── macOS: JXA(osascript -l JavaScript)로 CoreGraphics 이벤트 — 외부 바이너리 없이 마우스·스크롤. 키·문자 입력은 System Events.
const MAC_KEYCODES = { enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, forwarddelete: 117, home: 115, end: 119, pageup: 116, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126, arrowleft: 123, arrowright: 124, arrowdown: 125, arrowup: 126, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
/** "cmd+shift+t" → AppleScript keystroke/key code 문장(순수) */
export function macKeyScript(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean); const name = (parts.pop() ?? '').toLowerCase();
  const mods = parts.map((m) => m.toLowerCase()).map((m) => ({ cmd: 'command down', command: 'command down', meta: 'command down', ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down' })[m]).filter(Boolean);
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  if (name in MAC_KEYCODES) return `tell application "System Events" to key code ${MAC_KEYCODES[name]}${using}`;
  if (name.length === 1) return `tell application "System Events" to keystroke ${JSON.stringify(name)}${using}`;
  throw new Error(`unknown key: ${combo}`);
}
/** CoreGraphics 마우스 이벤트 JXA(순수). kind: move|left|right|double|drag(x2,y2)|scroll(dx,dy) */
export function macMouseJxa(kind, x, y, extra = {}) {
  const head = `ObjC.import('CoreGraphics'); ObjC.import('ApplicationServices'); if (!$.AXIsProcessTrusted()) throw new Error('AX_DENIED');
const post = (ev) => { $.CGEventPost($.kCGHIDEventTap, ev); }; const pt = (x, y) => $.CGPointMake(x, y); const sleep = (ms) => delay(ms / 1000);
const mouse = (type, x, y, btn) => $.CGEventCreateMouseEvent(null, type, pt(x, y), btn);`;
  const L = 0, R = 1;
  const body = kind === 'move' ? `post(mouse($.kCGEventMouseMoved, ${x}, ${y}, ${L}));`
    : kind === 'left' || kind === 'double' ? `post(mouse($.kCGEventMouseMoved, ${x}, ${y}, ${L})); sleep(30);
const n = ${kind === 'double' ? 2 : 1}; for (let i = 1; i <= n; i++) { const d = mouse($.kCGEventLeftMouseDown, ${x}, ${y}, ${L}); $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, i); post(d); const u = mouse($.kCGEventLeftMouseUp, ${x}, ${y}, ${L}); $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, i); post(u); sleep(60); }`
    : kind === 'right' ? `post(mouse($.kCGEventMouseMoved, ${x}, ${y}, ${R})); sleep(30); post(mouse($.kCGEventRightMouseDown, ${x}, ${y}, ${R})); post(mouse($.kCGEventRightMouseUp, ${x}, ${y}, ${R}));`
    : kind === 'drag' ? `post(mouse($.kCGEventMouseMoved, ${x}, ${y}, ${L})); sleep(50); post(mouse($.kCGEventLeftMouseDown, ${x}, ${y}, ${L})); sleep(80);
const steps = 12; for (let i = 1; i <= steps; i++) { post(mouse($.kCGEventLeftMouseDragged, ${x} + (${extra.x2} - ${x}) * i / steps, ${y} + (${extra.y2} - ${y}) * i / steps, ${L})); sleep(20); } post(mouse($.kCGEventLeftMouseUp, ${extra.x2}, ${extra.y2}, ${L}));`
    : kind === 'scroll' ? `${x != null ? `post(mouse($.kCGEventMouseMoved, ${x}, ${y}, ${L})); sleep(30);` : ''} post($.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${-(extra.dy ?? 0)}, ${-(extra.dx ?? 0)}));`
    : (() => { throw new Error(`unknown mouse kind ${kind}`); })();
  return `${head}\n${body}\n'ok'`;
}
const AX_HELP = 'macOS 접근성 권한이 없어 마우스·키보드를 제어할 수 없습니다 — 시스템 설정 → 개인정보 보호 및 보안 → 손쉬운 사용에서 Argo(또는 실행 중인 터미널/Node)를 허용하세요';
async function macJxa(script) {
  try { return await run('osascript', ['-l', 'JavaScript', '-e', script]); }
  catch (e) { if (/AX_DENIED/.test(String(e.message))) throw new Error(AX_HELP); throw e; }
}

// ── Windows: PowerShell(user32·System.Drawing). 한 스크립트로 캡처·입력 모두.
const PS_PRELUDE = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing;
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class U { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e); }
"@;`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell 작은따옴표 리터럴 — $·백틱 보간 없음(입력 텍스트가 명령이 되지 않게)
export function winScript(kind, a = {}) {
  const m = (f, d = 0) => `[U]::mouse_event(${f}, 0, 0, ${d}, [UIntPtr]::Zero)`;
  const move = (x, y) => `[U]::SetCursorPos(${x}, ${y}); Start-Sleep -Milliseconds 30;`;
  const click = `${m(2)}; ${m(4)};`; const rclick = `${m(8)}; ${m(16)};`;
  const body = kind === 'screenshot' ? `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
$w = [Math]::Min(1280, $b.Width); $h = [int]($b.Height * $w / $b.Width); $s = New-Object System.Drawing.Bitmap $w, $h; $gs = [System.Drawing.Graphics]::FromImage($s); $gs.DrawImage($bmp, 0, 0, $w, $h); $s.Save(${psq(a.file)}, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output "$($b.Width)x$($b.Height)->$($w)x$($h)"`
    : kind === 'move' ? move(a.x, a.y)
    : kind === 'left' ? `${move(a.x, a.y)} ${click}` : kind === 'double' ? `${move(a.x, a.y)} ${click} Start-Sleep -Milliseconds 60; ${click}` : kind === 'right' ? `${move(a.x, a.y)} ${rclick}`
    : kind === 'drag' ? `${move(a.x, a.y)} ${m(2)}; Start-Sleep -Milliseconds 80; ${move(a.x2, a.y2)} ${m(4)};`
    : kind === 'scroll' ? `${a.x != null ? move(a.x, a.y) : ''} ${m(0x0800, (-(a.dy ?? 0) * 120) & 0xFFFFFFFF)};`
    : kind === 'type' ? `[System.Windows.Forms.SendKeys]::SendWait(${psq(String(a.text).replace(/[+^%~(){}\[\]]/g, '{$&}'))});`
    : kind === 'key' ? `[System.Windows.Forms.SendKeys]::SendWait(${psq(winKeyString(a.key))});`
    : (() => { throw new Error(`unknown kind ${kind}`); })();
  return `${PS_PRELUDE}\n${body}`;
}
const WIN_KEYS = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', space: ' ', home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', arrowup: '{UP}', arrowdown: '{DOWN}', arrowleft: '{LEFT}', arrowright: '{RIGHT}' };
export function winKeyString(combo) {
  const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean); const name = (parts.pop() ?? '').toLowerCase();
  const mods = parts.map((p) => ({ ctrl: '^', control: '^', alt: '%', shift: '+', cmd: '^', meta: '^' })[p.toLowerCase()] ?? '').join('');
  const key = WIN_KEYS[name] ?? (/^f\d{1,2}$/.test(name) ? `{${name.toUpperCase()}}` : name.length === 1 ? name : (() => { throw new Error(`unknown key: ${combo}`); })());
  return mods ? `${mods}(${key})` : key;
}

/** 실행기 — 스크린샷은 { image, mime, note }를 돌려주고 호출부가 비전 지원에 따라 이미지 블록/파일 저장을 결정한다. */
export function computerRunners({ platform = process.platform, exec = run, jxa = macJxa } = {}) {
  const mac = platform === 'darwin', win = platform === 'win32';
  const linux = !mac && !win;
  const xdo = (...args) => exec('xdotool', args);
  return {
    computer_screenshot: async () => {
      const dir = await mkdtemp(join(tmpdir(), 'argo-shot-')); const file = join(dir, 'shot.png');
      let note = '';
      try {
        if (mac) {
          await exec('screencapture', ['-x', '-t', 'png', file]);
          const info = await exec('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]).catch(() => '');
          const w = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1] || 0), h = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1] || 0);
          if (w > 1280) await exec('sips', ['-Z', '1280', file]);
          const sw = w > 1280 ? 1280 : w, sh = w > 1280 ? Math.round(h * 1280 / w) : h;
          // 좌표 안내 — 레티나(2x)는 논리 화면 좌표가 픽셀의 절반. computer_click 좌표는 **논리 좌표**(스크린샷 픽셀 × scale)
          const logicalW = Number((await exec('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']).catch(() => '')).split(',')[2] || 0);
          const scale = logicalW && sw ? (logicalW / sw) : 1;
          note = `screenshot ${sw}x${sh} (원본 ${w}x${h}); 클릭 좌표 = 스크린샷 픽셀 × ${scale.toFixed(3)} (논리 화면 ${logicalW || '?'}px 폭)`;
        } else if (win) { const out = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('screenshot', { file })]); note = `screenshot ${out.trim()} (클릭 좌표 = 원본 픽셀 × 원본/축소 비율)`; }
        else { await exec('import', ['-window', 'root', file]); note = 'screenshot (xdotool 좌표 = 원본 픽셀)'; }
        const image = await readFile(file);
        return { image, mime: 'image/png', note };
      } catch (e) {
        if (mac && /not permitted|could not create image|screen recording/i.test(String(e.message))) throw new Error('화면 기록 권한이 없어 스크린샷을 찍을 수 없습니다 — 시스템 설정 → 개인정보 보호 및 보안 → 화면 및 시스템 오디오 녹음에서 Argo(또는 실행 중인 터미널/Node)를 허용하세요');
        if (linux && /ENOENT/.test(String(e.message))) throw new Error('리눅스 컴퓨터 유즈에는 xdotool과 ImageMagick(import)이 필요합니다');
        throw e;
      } finally { await unlink(file).catch(() => {}); }
    },
    computer_move: async ({ x, y }) => { const X = num(x, 'x'), Y = num(y, 'y'); if (mac) await jxa(macMouseJxa('move', X, Y)); else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('move', { x: X, y: Y })]); else await xdo('mousemove', String(X), String(Y)); return `moved to ${X},${Y}`; },
    computer_click: async ({ x, y, button = 'left' }) => {
      const X = num(x, 'x'), Y = num(y, 'y'); const kind = button === 'double' ? 'double' : button === 'right' ? 'right' : 'left';
      if (mac) await jxa(macMouseJxa(kind, X, Y)); else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript(kind, { x: X, y: Y })]);
      else { await xdo('mousemove', String(X), String(Y)); await xdo('click', ...(kind === 'double' ? ['--repeat', '2', '1'] : kind === 'right' ? ['3'] : ['1'])); }
      return `${kind} click at ${X},${Y}`;
    },
    computer_drag: async ({ x1, y1, x2, y2 }) => {
      const a = { x: num(x1, 'x1'), y: num(y1, 'y1'), x2: num(x2, 'x2'), y2: num(y2, 'y2') };
      if (mac) await jxa(macMouseJxa('drag', a.x, a.y, { x2: a.x2, y2: a.y2 })); else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('drag', a)]);
      else { await xdo('mousemove', String(a.x), String(a.y)); await xdo('mousedown', '1'); await xdo('mousemove', String(a.x2), String(a.y2)); await xdo('mouseup', '1'); }
      return `dragged ${a.x},${a.y} → ${a.x2},${a.y2}`;
    },
    computer_type: async ({ text }) => {
      const t = String(text ?? ''); if (!t) return 'nothing to type';
      if (mac) { // 유니코드(한글) 안전 — 클립보드 경유 붙여넣기(System Events keystroke는 ASCII 밖에서 깨진다)
        await exec('osascript', ['-e', `set the clipboard to ${JSON.stringify(t)}`, '-e', 'tell application "System Events" to keystroke "v" using {command down}']);
      } else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('type', { text: t })]);
      else await xdo('type', '--delay', '20', t);
      return `typed ${t.length} chars`;
    },
    computer_key: async ({ key }) => {
      const k = String(key ?? ''); if (!k) throw new Error('key required');
      if (mac) await exec('osascript', ['-e', macKeyScript(k)]); else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('key', { key: k })]);
      else await xdo('key', k.replace(/cmd|meta/gi, 'super'));
      return `pressed ${k}`;
    },
    computer_scroll: async ({ x, y, dy = 0, dx = 0 }) => {
      const DY = num(dy, 'dy'), DX = num(dx ?? 0, 'dx'); const X = x == null ? null : num(x, 'x'), Y = y == null ? null : num(y, 'y');
      if (mac) await jxa(macMouseJxa('scroll', X, Y, { dy: DY, dx: DX })); else if (win) await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', winScript('scroll', { x: X, y: Y, dy: DY })]);
      else { if (X != null) await xdo('mousemove', String(X), String(Y)); for (let i = 0; i < Math.abs(DY); i++) await xdo('click', DY > 0 ? '5' : '4'); }
      return `scrolled dy=${DY} dx=${DX}`;
    },
  };
}
