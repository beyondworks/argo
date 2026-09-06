// 시뮬레이션 — 모델이 흔히 내는 셸 명령 묶음을 여러 셸(cmd.exe / Git Bash / busybox sh / 맥·리눅스 sh·bash)로 돌려 통과율을 잰다.
// 아르고 Bash 도구를 윈도우에서 POSIX 셸로 바꾸기 전 근거 수집용(제품 코드 아님, 브랜치 sim/win-shell 전용).
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const win = process.platform === 'win32';
const SHELLS = win ? {
  'cmd.exe': { file: 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] },
  'git-bash': { file: process.env.GIT_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe', args: (c) => ['-c', c] },
  'busybox-sh': { file: process.env.BUSYBOX || resolve('sim-bin', 'busybox64.exe'), args: (c) => ['sh', '-c', c] },
} : {
  'sh': { file: '/bin/sh', args: (c) => ['-c', c] },
  'bash': { file: '/bin/bash', args: (c) => ['-c', c] },
};
const rx = (r) => (out, code) => code === 0 && r.test(out);
// cls: posix(POSIX sh 표준) · bashism(bash 전용 문법) · win(cmd/PowerShell 문법) · path(윈도우식 경로) · enc(인코딩)
const CORPUS = [
  { id: 1, cls: 'posix', cmd: 'ls -la', ok: rx(/package\.json/) },
  { id: 2, cls: 'posix', cmd: 'pwd', ok: rx(/\S/) },
  { id: 3, cls: 'posix', cmd: 'cat package.json | head -5', ok: rx(/"name"/) },
  { id: 4, cls: 'posix', cmd: 'grep -n "\\"name\\"" package.json | head -3', ok: rx(/name/) },
  { id: 5, cls: 'posix', cmd: 'find . -maxdepth 1 -name "*.json" | wc -l', ok: rx(/[1-9]/) },
  { id: 6, cls: 'posix', cmd: 'git status --short | head -3; git log --oneline -1', ok: rx(/[0-9a-f]{7}/) },
  { id: 7, cls: 'posix', cmd: 'mkdir -p sim-out && echo "hello" > sim-out/x.txt && cat sim-out/x.txt', ok: rx(/hello/) },
  { id: 8, cls: 'posix', cmd: 'mkdir -p sim-out/a/b && cd sim-out/a/b && pwd', ok: rx(/sim-out[\\/]a[\\/]b/) },
  { id: 9, cls: 'posix', cmd: 'export FOO=1; echo "foo=$FOO"', ok: rx(/foo=1/) },
  { id: 10, cls: 'posix', cmd: 'X=$(node -e "console.log(21*2)"); echo "answer=$X"', ok: rx(/answer=42/) },
  { id: 11, cls: 'posix', cmd: "mkdir -p sim-out && cat <<'EOF' > sim-out/h.txt\nline1\nline2\nEOF\ncat sim-out/h.txt", ok: rx(/line1\s+line2/) },
  { id: 12, cls: 'posix', cmd: "sed -n '1,3p' package.json", ok: rx(/\{/) },
  { id: 13, cls: 'posix', cmd: 'wc -l package.json', ok: rx(/\d+/) },
  { id: 14, cls: 'posix', cmd: 'test -f package.json && echo yes || echo no', ok: rx(/yes/) },
  { id: 15, cls: 'posix', cmd: '[ -d src ] && echo dir', ok: rx(/dir/) },
  { id: 16, cls: 'posix', cmd: 'for f in *.json; do echo "F:$f"; done | head -3', ok: rx(/F:package\.json/) },
  { id: 17, cls: 'posix', cmd: 'node -e "console.log(process.platform)"', ok: rx(/win32|darwin|linux/) },
  { id: 18, cls: 'posix', cmd: 'npm --version', ok: rx(/\d+\.\d+/) },
  { id: 19, cls: 'posix', cmd: 'printf "%s\\n" b a | sort', ok: rx(/a\s+b/) },
  { id: 20, cls: 'posix', cmd: 'ls nonexistent 2>/dev/null || echo missing', ok: rx(/missing/) },
  { id: 21, cls: 'posix', cmd: 'set -e; false; echo notreached', ok: (out, code) => code !== 0 && !/notreached/.test(out) },
  { id: 22, cls: 'posix', cmd: 'command -v node', ok: rx(/node/) },
  { id: 23, cls: 'posix', cmd: 'rm -rf sim-out/a && ls sim-out', ok: (out, code) => code === 0 && !/(^|\s)a(\s|$)/.test(out) },
  { id: 24, cls: 'posix', cmd: 'date +%Y', ok: rx(/20\d\d/) },
  { id: 25, cls: 'posix', cmd: 'echo "a b" | awk \'{print $2}\'', ok: rx(/^b/m) },
  { id: 26, cls: 'posix', cmd: 'echo $HOME', ok: rx(/[\\/]/) },
  { id: 27, cls: 'posix', cmd: 'ls src/engine/*.mjs | head -2', ok: rx(/\.mjs/) },
  { id: 28, cls: 'posix', cmd: 'head -c 100 package.json; echo; tail -n 2 package.json', ok: rx(/\}/) },
  { id: 29, cls: 'posix', cmd: 'echo "x,y,z" | cut -d, -f2', ok: rx(/^y/m) },
  { id: 30, cls: 'posix', cmd: 'if [ "$(echo hi)" = "hi" ]; then echo same; fi', ok: rx(/same/) },
  { id: 31, cls: 'bashism', cmd: '[[ "abc" == a* ]] && echo match', ok: rx(/match/) },
  { id: 32, cls: 'bashism', cmd: 'arr=(1 2); echo ${arr[1]}', ok: rx(/^2/m) },
  { id: 33, cls: 'bashism', cmd: 'cut -d, -f2 <<< "x,y,z"', ok: rx(/^y/m) },
  { id: 34, cls: 'bashism', cmd: 'set -o pipefail; false | true; echo "rc=$?"', ok: rx(/rc=1/) },
  { id: 35, cls: 'win', cmd: 'dir', ok: rx(/package\.json/) },
  { id: 36, cls: 'win', cmd: 'type package.json', ok: rx(/"name"/) },
  { id: 37, cls: 'win', cmd: 'findstr /i "name" package.json', ok: rx(/name/) },
  { id: 38, cls: 'win', cmd: 'where node', ok: rx(/node/) },
  { id: 39, cls: 'win', cmd: 'copy package.json sim-out\\pkg.txt && type sim-out\\pkg.txt', ok: rx(/"name"/) },
  { id: 40, cls: 'win', cmd: 'powershell -Command "Get-Date -Format yyyy"', ok: rx(/20\d\d/) },
  { id: 41, cls: 'win', cmd: 'set FOO=1 && echo %FOO%', ok: rx(/^1/m) },
  { id: 42, cls: 'win', cmd: 'echo %USERPROFILE%', ok: rx(/\\Users\\|\/Users\//) },
  { id: 43, cls: 'win', cmd: 'cd src && dir /b | findstr mjs', ok: rx(/\.mjs/) },
  { id: 44, cls: 'path', cmd: 'cat .\\package.json | head -2', ok: rx(/"name"|\{/) },
  { id: 45, cls: 'path', cmd: 'cat src\\engine\\native-flags.mjs | head -2', ok: rx(/import|export|\/\//) },
  { id: 46, cls: 'path', cmd: 'cat "src\\engine\\native-flags.mjs" | head -2', ok: rx(/import|export|\/\//) },
  { id: 47, cls: 'path', cmd: 'ls src/engine | head -2', ok: rx(/\.mjs/) },
  { id: 48, cls: 'enc', cmd: 'echo 한글 テスト', ok: rx(/한글 テスト/) },
  { id: 49, cls: 'enc', cmd: 'node -e "console.log(\'한글\')"', ok: rx(/한글/) },
  { id: 50, cls: 'enc', cmd: 'mkdir -p sim-out && printf "한글\\n" > sim-out/k.txt && cat sim-out/k.txt', ok: rx(/한글/) },
];
function run(sh, command) {
  return new Promise((res) => {
    const t0 = Date.now(); let out = '';
    const child = spawn(sh.file, sh.args(command), { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else child.kill('SIGKILL'); } catch { /* */ } }, 30_000);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); res({ code: 'spawn-error', out: e.message, ms: Date.now() - t0 }); });
    child.on('close', (code) => { clearTimeout(timer); res({ code, out, ms: Date.now() - t0 }); });
  });
}
const results = {}; const versions = {};
for (const [name, sh] of Object.entries(SHELLS)) {
  if (win && name !== 'cmd.exe' && !existsSync(sh.file)) { versions[name] = 'missing'; continue; }
  versions[name] = (await run(sh, name === 'cmd.exe' ? 'ver' : name === 'busybox-sh' ? 'busybox | head -1' : 'echo $BASH_VERSION')).out.trim().slice(0, 80);
  results[name] = [];
  for (const c of CORPUS) {
    rmSync('sim-out', { recursive: true, force: true });
    const r = await run(sh, c.cmd);
    const pass = c.ok(r.out, r.code);
    results[name].push({ id: c.id, pass, code: r.code, ms: r.ms, out: r.out.replace(/\s+/g, ' ').trim().slice(0, 90) });
  }
}
rmSync('sim-out', { recursive: true, force: true });
const names = Object.keys(results);
const lines = [`# 셸 시뮬레이션 (${process.platform}) — 셸 버전: ${JSON.stringify(versions)}`, '', `| # | 계열 | 명령 | ${names.join(' | ')} |`, `|---|---|---|${names.map(() => '---').join('|')}|`];
for (const c of CORPUS) lines.push(`| ${c.id} | ${c.cls} | \`${c.cmd.replace(/\|/g, '\\|').replace(/\n/g, '⏎').slice(0, 60)}\` | ${names.map((n) => { const r = results[n][c.id - 1]; return r.pass ? '✓' : `✗ (${r.code}: ${r.out.replace(/\|/g, '/').slice(0, 50)})`; }).join(' | ')} |`);
lines.push('', '## 계열별 통과');
for (const cls of ['posix', 'bashism', 'win', 'path', 'enc']) {
  const ids = CORPUS.filter((c) => c.cls === cls).map((c) => c.id);
  lines.push(`- ${cls} (${ids.length}): ${names.map((n) => `${n} ${results[n].filter((r) => ids.includes(r.id) && r.pass).length}/${ids.length}`).join(' · ')}`);
}
const md = lines.join('\n'); console.log(md);
mkdirSync('sim-result', { recursive: true }); writeFileSync(`sim-result/sim-${process.platform}.md`, md); writeFileSync(`sim-result/sim-${process.platform}.json`, JSON.stringify({ versions, results }, null, 1));
