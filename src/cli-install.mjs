// 앱을 설치하면 argo 명령이 따라온다 — 맥 shim 등록·상태·PATH 버튼(설계 2-3·2-5, 반대 검토 M-e·L-c, 2026-10-01).
// 윈도우는 NSIS 설치 프로그램(src-tauri/windows/hooks.nsh)이 같은 일을 하고 이 모듈은 그 결과 파일(cli-install.json)만 읽는다. 리눅스는 install.sh.
//
// 규칙(전부 테스트로 잠겨 있다 — test/cli-install.test.mjs):
//  ① 다른 프로그램의 `argo`(예: Argo Workflows CLI)는 덮어쓰지도, 가리지도 않는다. 고정 후보 경로(+사이드카의 PATH)에 우리 표식이 없는 argo가 하나라도 있으면
//     실행 파일을 만들지 않고 conflict로 남긴다. **로그인 셸은 실행하지 않는다**(셸 설정이 Documents·Desktop에 접근하면 Argo 이름으로 권한 창이 뜰 수 있다 — 검토 M-e).
//  ② 셸 파일(~/.zprofile 등)은 설정 화면의 버튼을 눌렀을 때만 고친다. 앱이 저절로 고치지 않는다.
//  ③ 같은 상태에서는 아무것도 다시 쓰지 않는다(shim·상태 파일 모두).
//  ④ 사용자가 제거했으면 앱이 다시 만들지 않는다 — 버튼으로만 다시 등록한다.
import { homedir } from 'node:os';
import { join, dirname, basename, delimiter } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync, realpathSync, openSync, readSync, closeSync, renameSync, chmodSync, rmSync, appendFileSync } from 'node:fs';

export const SHIM_MARK = 'argo-cli-shim v1 com.beyondworks.argo';
const PATH_MARK = '# Argo — 터미널 명령 argo (Argo 앱이 추가, 지워도 됩니다)';
const PATH_LINE = 'export PATH="$PATH:$HOME/.local/bin"';

/** 작은따옴표 이스케이프 — 공백·`$`·백틱·따옴표가 든 경로도 셸이 그대로 읽는다 */
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 맥 실행 파일 본문(순수). node·cli는 절대 경로 — 앱을 옮기면 다음 앱 실행 때 이 파일만 다시 쓴다. */
export function shimText({ node, cli }) {
  return `#!/bin/sh
# ${SHIM_MARK} — Argo 앱이 만든 파일입니다. 지워도 됩니다(앱 설정 → 기기에서도 제거할 수 있습니다).
N=${sq(node)}; C=${sq(cli)}
if [ ! -x "$N" ] || [ ! -f "$C" ]; then
  echo "argo: Argo 앱을 찾을 수 없습니다. 앱을 다시 설치하거나 이 파일을 지우세요: $0" >&2
  echo "argo: Argo app not found. Reinstall it, or delete this file: $0" >&2
  exit 127
fi
# Dock 아이콘 억제 — 앱이 ~/.argo/tools에 둔 프리로드를 번들 node의 자식(MCP·npx)이 상속하게 한다. HOME에 특수 문자가 있으면 조립하지 않는다(NODE_OPTIONS 파싱이 깨진다).
D="$HOME/.argo/tools/no-dock.cjs"
case "$HOME" in *[!A-Za-z0-9._/-]*) ;; *) if [ -f "$D" ]; then case "$NODE_OPTIONS" in *"$D"*) ;; *) NODE_OPTIONS="--require $D\${NODE_OPTIONS:+ $NODE_OPTIONS}"; export NODE_OPTIONS ;; esac; fi ;; esac
ARGO_CLI_APP=1 exec "$N" "$C" "$@"
`;
}

/** 화면에 보이는 "직접 실행" 명령용 인용 — 그대로 복사해 붙여 넣으면 실행돼야 한다(공백·$·따옴표가 든 경로, 독립 검수 #800 LOW-6). 안전한 문자만이면 그대로. */
const shq = (p) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : sq(p));
const winq = (p) => (/[\s&^()%!;,=]/.test(p) ? `"${p}"` : p);
const defaultCandidates = (home) => [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, 'bin'), join(home, 'go', 'bin'), join(home, '.npm-global', 'bin'), '/usr/bin'];
const head = (f, n = 512) => { // 파일 앞 n바이트 — 표식 확인용(전체를 읽지 않는다)
  let fd; try { fd = openSync(f, 'r'); const b = Buffer.alloc(n); const len = readSync(fd, b, 0, n, 0); return b.subarray(0, len).toString('utf8'); } catch { return ''; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* 무해 */ } }
};
const lstat = (f) => { try { return lstatSync(f); } catch { return null; } };

/** 한 경로의 argo 분류 — ours(우리 표식) | argo-dev(Argo 저장소를 npm link한 것) | foreign */
function classify(file) {
  const st = lstat(file); if (!st) return null;
  if (st.isSymbolicLink()) {
    try {
      const real = realpathSync(file);
      const pkg = join(dirname(dirname(real)), 'package.json');
      if (basename(real) === 'argo.mjs' && existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'argo') return { kind: 'argo-dev', symlink: true };
    } catch { /* 깨진 링크·읽기 실패 — 남의 것으로 */ }
    return { kind: 'foreign', symlink: true };
  }
  if (!st.isFile()) return { kind: 'foreign', symlink: false };
  return { kind: head(file).includes(SHIM_MARK) ? 'ours' : 'foreign', symlink: false };
}

/** 이 컴퓨터의 argo 목록 — 고정 후보 경로와 사이드카 PATH의 폴더에서 `argo` 파일만(셸 미실행). 같은 파일은 한 번만. */
export function findArgos({ env = process.env, home = homedir(), candidates = defaultCandidates(home), platform = process.platform } = {}) {
  const dirs = [...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean), ...candidates];
  const names = platform === 'win32' ? ['argo.exe', 'argo.cmd', 'argo.bat'] : ['argo']; // 윈도우는 PATHEXT 순서의 실행 파일들
  const seen = new Set(); const out = [];
  for (const dir of dirs) for (const name of names) {
    const file = join(dir, name);
    let key = file; try { key = realpathSync(dirname(file)) + '/' + basename(file); } catch { /* 폴더 없음 */ }
    if (seen.has(key)) continue; seen.add(key);
    const c = classify(file); if (c) out.push({ path: file, dir, ...c });
  }
  return out;
}

const SHELL_FILES = { zsh: ['.zshenv', '.zprofile', '.zshrc', '.zlogin'], bash: ['.bash_profile', '.bash_login', '.profile', '.bashrc'], sh: ['.profile'] };
const shellName = (env) => basename(env.SHELL || '').replace(/\.exe$/, '');
/** ~/.local/bin이 이미 터미널 PATH 설정에 있는가 — **셸 설정 파일의 텍스트만** 본다(셸을 실행하지 않는다).
    현재 프로세스의 process.env.PATH는 믿지 않는다: 앱 사이드카는 src/runners/shared.mjs가 GUI 최소 PATH를 보강하느라 `~/.local/bin`을 스스로 PATH에 합친다
    (실측 2026-10-01: 서버 부팅 직후 곧바로 PATH에 들어가 "이미 있음"이 항상 참이 됐다 — 터미널은 그 PATH를 쓰지 않는데). 주석 줄은 제외한다.
    /etc/paths·/etc/paths.d에 홈의 절대 경로로 들어 있는 경우도 본다(macOS path_helper). */
function pathReady({ env, home, dir }) {
  const hasLine = (file) => { try { return readFileSync(file, 'utf8').split('\n').some((l) => !/^\s*#/.test(l) && /\.local\/bin/.test(l)); } catch { return false; } };
  const names = [...new Set([...(SHELL_FILES[shellName(env)] ?? []), ...SHELL_FILES.zsh, ...SHELL_FILES.bash])];
  if (names.some((n) => hasLine(join(home, n)))) return true;
  const sys = ['/etc/paths', ...(() => { try { return readdirSync('/etc/paths.d').map((n) => join('/etc/paths.d', n)); } catch { return []; } })()];
  return sys.some((f) => { try { return readFileSync(f, 'utf8').split('\n').some((l) => l.trim() === dir); } catch { return false; } });
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
/** 상태 파일은 달라졌을 때만 쓴다 */
function saveState(stateFile, state) {
  const next = JSON.stringify(state, null, 2) + '\n';
  try { if (readFileSync(stateFile, 'utf8') === next) return; } catch { /* 없음 */ }
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}`; writeFileSync(tmp, next); renameSync(tmp, stateFile);
}
function writeShim(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, text, { mode: 0o755 }); chmodSync(tmp, 0o755); renameSync(tmp, file);
}

const ctx = (o = {}) => {
  const env = o.env ?? process.env; const home = o.home ?? homedir(); const platform = o.platform ?? process.platform;
  const root = env.ARGO_ROOT;
  const serverDir = o.serverDir ?? process.cwd(); // 사이드카의 작업 폴더 = 번들 server 폴더(lib.rs current_dir)
  return {
    env, home, platform, execPath: o.execPath ?? process.execPath, serverDir,
    stateFile: o.stateFile ?? (platform === 'win32' && env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'com.beyondworks.argo', 'cli-install.json') : root ? join(dirname(root), 'cli-install.json') : join(home, '.argo', 'cli-install.json')),
    candidates: o.candidates ?? defaultCandidates(home),
  };
};
const cliPath = (c) => join(c.serverDir, 'bin', 'argo.mjs');
const shimFile = (c) => join(c.home, '.local', 'bin', 'argo');
const translocated = (p) => /\/AppTranslocation\//.test(p) || /^\/Volumes\//.test(p);

/** 지금 상태(순수 조회 — 아무것도 쓰지 않는다). 설정 화면이 읽는다. */
export async function cliInstallStatus(o = {}) {
  const c = ctx(o);
  if (c.platform === 'win32') { // 설치 프로그램이 남긴 결과(NSIS)와 실제 파일
    const st = readJson(c.stateFile) ?? {};
    const cmd = join(dirname(c.execPath), 'cli', 'argo.cmd');
    // 설치 프로그램은 상태(installed|conflict|path-skipped)만 ASCII로 남긴다(NSIS는 ANSI로 써서 한글 경로가 깨진다). 다른 argo의 경로는 여기서 PATH를 직접 훑어 찾는다.
    const others = findArgos({ env: c.env, home: c.home, candidates: [], platform: 'win32' }).filter((a) => a.kind !== 'ours').map(({ path, kind }) => ({ path, kind }));
    return { platform: 'win32', status: existsSync(cmd) ? (st.status ?? 'installed') : 'unavailable', shim: cmd, run: winq(cmd), others, pathReady: (st.status ?? 'installed') === 'installed' };
  }
  if (c.platform !== 'darwin') return { platform: c.platform, status: 'unsupported', others: [] };
  const state = readJson(c.stateFile) ?? {};
  const shim = shimFile(c); const mine = classify(shim);
  const others = findArgos(c).filter((a) => a.kind !== 'ours').map(({ path, kind }) => ({ path, kind }));
  let status = state.status ?? 'unknown';
  if (translocated(c.execPath)) status = 'translocated';
  else if (mine?.kind === 'ours') status = 'installed';
  else if (state.status === 'removed') status = 'removed';
  else if (mine || others.length) status = 'conflict';
  else if (status === 'installed') status = 'missing'; // 우리가 만들었는데 사라짐(사용자가 지움 등)
  return { platform: 'darwin', status, shim, run: mine?.kind === 'ours' ? shq(shim) : `${shq(c.execPath)} ${shq(cliPath(c))}`, others, pathReady: pathReady({ env: c.env, home: c.home, dir: dirname(shim) }), pathLine: PATH_LINE };
}

/** 앱 시작 때 1회·멱등 — 맥에서만. 사용자 제거는 존중하고, 남의 argo는 건드리지 않으며, 같은 상태면 쓰지 않는다. */
export async function ensureCliInstalled(o = {}) {
  const c = ctx(o);
  if (c.platform !== 'darwin') return { status: 'unsupported' };
  const state = readJson(c.stateFile) ?? {};
  const finish = (status, extra = {}) => { saveState(c.stateFile, { ...state, status, ...extra, others: extra.others ?? [] }); return { status, ...extra }; };
  if (translocated(c.execPath)) return finish('translocated');
  if (!existsSync(cliPath(c))) return finish('unavailable');
  if (state.status === 'removed') return { status: 'removed' }; // 사용자가 지웠다 — 버튼으로만 다시
  return register(c, state, finish);
}

function register(c, state, finish) {
  const shim = shimFile(c);
  const want = shimText({ node: c.execPath, cli: cliPath(c) });
  const all = findArgos(c);
  const others = all.filter((a) => a.kind !== 'ours').map(({ path, kind }) => ({ path, kind }));
  const mine = classify(shim);
  if (mine?.kind === 'ours' && !mine.symlink) {
    let cur = ''; try { cur = readFileSync(shim, 'utf8'); } catch { /* 읽기 실패 — 다시 쓴다 */ }
    if (cur !== want) writeShim(shim, want); // 앱을 옮겼거나 업데이트로 shim 형식이 바뀜 — 우리 표식이 있는 파일만
    return finish('installed', { others, shim });
  }
  if (mine || others.length) return finish('conflict', { others, shim });
  writeShim(shim, want);
  return finish('installed', { others: [], shim });
}

/** 설정 화면 버튼 — 등록(제거했던 것도 다시). 남의 argo가 있으면 똑같이 건너뛴다. */
export async function installCli(o = {}) {
  const c = ctx(o);
  if (c.platform !== 'darwin') return { status: 'unsupported' };
  const state = readJson(c.stateFile) ?? {};
  const finish = (status, extra = {}) => { saveState(c.stateFile, { ...state, status, ...extra, others: extra.others ?? [] }); return { status, ...extra }; };
  if (translocated(c.execPath)) return finish('translocated');
  if (!existsSync(cliPath(c))) return finish('unavailable');
  return register(c, state, finish);
}

/** 설정 화면 버튼 — 제거. 우리 표식이 있는 파일만 지운다(남의 것·링크는 그대로). 셸 파일의 PATH 줄은 남긴다(지워도 되는 한 줄). */
export async function removeCli(o = {}) {
  const c = ctx(o);
  if (c.platform !== 'darwin') return { status: 'unsupported' };
  const shim = shimFile(c); const mine = classify(shim);
  if (mine?.kind === 'ours' && !mine.symlink) rmSync(shim, { force: true });
  const state = readJson(c.stateFile) ?? {};
  saveState(c.stateFile, { ...state, status: 'removed', others: [] });
  return { status: 'removed' };
}

/** 설정 화면 버튼 — 셸 파일에 PATH 한 줄. 이 함수만 셸 파일을 고친다. O_APPEND로 덧붙이고 파일 전체를 다시 쓰거나 rename하지 않는다(심볼릭 링크·권한 보존). */
export async function addPathToShell(o = {}) {
  const c = ctx(o);
  if (c.platform !== 'darwin') return { result: 'unsupported' };
  const dir = join(c.home, '.local', 'bin');
  if (pathReady({ env: c.env, home: c.home, dir })) return { result: 'already' };
  const sh = shellName(c.env);
  let file;
  if (sh === 'zsh') file = join(c.home, '.zprofile');
  else if (sh === 'bash') file = ['.bash_profile', '.bash_login', '.profile'].map((n) => join(c.home, n)).find((f) => existsSync(f)) ?? join(c.home, '.bash_profile');
  else return { result: 'manual', line: PATH_LINE };
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { /* 새 파일 */ }
  // 표식 주석만 남고 export 줄이 없으면(사용자가 줄만 지움) 줄만 다시 넣는다 — 주석만 보고 "이미 있다"고 하지 않는다(독립 검수 #800 LOW-5).
  // 두 줄이 다 있는데 pathReady가 거짓인 경우(예: 줄이 주석 처리됨)는 사용자가 일부러 끈 것이라 건드리지 않는다.
  if (text.includes(PATH_MARK) && text.includes(PATH_LINE)) return { result: 'already', file };
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${text.includes(PATH_MARK) ? '' : `${PATH_MARK}\n`}${PATH_LINE}\n`);
  const state = readJson(c.stateFile) ?? {};
  saveState(c.stateFile, { ...state, pathLine: { file } });
  return { result: 'added', file };
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/;
/** 설정 화면 API(app/api/cli-install/route.js)의 요청 게이트(순수). 데스크톱 사이드카(ARGO_PARENT_PID)가 아니면 404 — 셀프호스트 웹에서 서버 사용자의 셸 파일을 고치지 못하게.
    루프백이 아니면 403, 다른 사이트(Sec-Fetch-Site가 same-origin·none이 아님)의 요청도 403. 헤더가 없는 비브라우저(curl)는 CSRF 대상이 아니라 통과. 거절이면 { status, error }, 통과면 null. */
export function cliInstallRequestDenied({ env = process.env, host, secFetchSite } = {}) {
  if (!env.ARGO_PARENT_PID) return { status: 404, error: 'not found' };
  if (!LOOPBACK.test(host || '')) return { status: 403, error: 'loopback only' };
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return { status: 403, error: 'cross-origin' };
  return null;
}

/** 설정 화면 버튼 동작 — 같은 모듈 함수로 실행하고 새 상태를 돌려준다. action: install | remove | path */
export async function cliInstallAction(action, o = {}) {
  let pathResult = null;
  if (action === 'install') await installCli(o);
  else if (action === 'remove') await removeCli(o);
  else if (action === 'path') pathResult = await addPathToShell(o);
  else throw new Error(`unknown action: ${String(action).slice(0, 40)}`);
  const status = await cliInstallStatus(o);
  return { ...status, ...(pathResult ? { pathResult: pathResult.result, pathFile: pathResult.file, pathLine: pathResult.line ?? status.pathLine } : {}) };
}
