// 네이티브 엔진 내장 도구 7종 — 이름·인자를 Claude Code 도구와 같게 둔다(Read·Write·Edit·Glob·Grep·Bash·WebFetch).
// 그래야 permission-gate(readToolTargets: file_path·path·pattern·command)가 **한 글자도 바뀌지 않고** 같은 판정을 한다.
// 하네스 통일의 요점: 어느 러너든 이 도구들이 같은 게이트를 지난다(SDK 경로는 allowedTools 항목이 게이트를 우회했다).
import { readFile, writeFile, mkdir, stat, glob as fsGlob } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path';

const OUT_CAP = 30_000; // 도구 출력 상한(문자) — 모델 문맥 보호
const READ_LINE_CAP = 2000;

export const BUILTIN_SPECS = Object.freeze([
  { name: 'Read', description: 'Read a file from the filesystem. Returns numbered lines. Paths may be absolute or relative to the company folder.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'Write', description: 'Write (create or overwrite) a file. Parent folders are created.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Glob', description: 'Find files by glob pattern (e.g. "**/*.md"). path = base folder (default: company folder). Returns up to 500 paths.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents with a regular expression. path = file or folder (default: company folder). output_mode: content | files_with_matches | count.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, '-i': { type: 'boolean' }, head_limit: { type: 'number' } }, required: ['pattern'] } },
  { name: 'Bash', description: 'Run a shell command in the company folder. Output (stdout+stderr) is capped. timeout in ms (default 120000, max 600000).',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, description: { type: 'string' } }, required: ['command'] } },
  { name: 'WebFetch', description: 'Fetch a URL and return its text content (HTML tags stripped, capped).',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url'] } },
]);

const cap = (s, n = OUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const abs = (cwd, p) => (isAbsolute(String(p)) ? resolve(String(p)) : resolve(cwd, String(p)));
const posix = (p) => String(p).split(sep).join('/'); // 도구 출력 경로는 OS 무관 `/` — 윈도우 fs.glob이 `a\x.md`를 돌려준다(CI windows-latest 실측 2026-09-05)
const SKIP_DIR_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/; // 구분자 무관 제외(윈도우 경로는 백슬래시)

/** 셸 자식 env — 러너 자격(ANTHROPIC_*·OAuth)은 크루 명령에 필요 없다. SDK 경로는 상속시켰지만 여기서는 뺀다(시크릿 규칙). */
export function shellEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CONFIG_DIR$)/.test(k)) out[k] = v;
  return out;
}

async function runBash(cwd, env, { command, timeout }, signal) {
  const ms = Math.min(Math.max(Number(timeout) || 120_000, 1000), 600_000);
  const win = process.platform === 'win32';
  return await new Promise((res) => {
    const child = spawn(win ? 'cmd.exe' : '/bin/sh', win ? ['/d', '/s', '/c', command] : ['-c', command],
      { cwd, env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let done = false;
    const finish = (tail) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); res(cap(out) + tail); };
    const kill = () => { try { if (win) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); else process.kill(-child.pid, 'SIGKILL'); } catch { /* 이미 종료 */ } };
    const onAbort = () => { kill(); finish('\n[aborted]'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { kill(); finish(`\n[timeout after ${ms}ms]`); }, ms);
    child.stdout.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    child.stderr.on('data', (d) => { if (out.length < OUT_CAP * 2) out += d; });
    child.on('error', (e) => finish(`\n[spawn error: ${e.message}]`));
    child.on('close', (code) => finish(code === 0 ? '' : `\n[exit ${code}]`));
  });
}

async function grepJs(root, re, globPat, mode, headLimit) {
  const files = [];
  const st = await stat(root).catch(() => null);
  if (st?.isFile()) files.push(root);
  else for await (const f of fsGlob(globPat || '**/*', { cwd: root, exclude: (p) => SKIP_DIR_RE.test(p) })) files.push(resolve(root, f));
  const lines = []; const hits = []; let n = 0;
  for (const f of files) {
    const s = await stat(f).catch(() => null); if (!s?.isFile() || s.size > 2_000_000) continue;
    const txt = await readFile(f, 'utf8').catch(() => null); if (txt == null) continue;
    let c = 0;
    const rel = posix(relative(root, f) || f);
    txt.split('\n').forEach((line, i) => { if (re.test(line)) { c += 1; if (mode === 'content' && lines.length < headLimit) lines.push(`${rel}:${i + 1}:${line}`); } });
    if (c) { n += c; hits.push({ f: rel, c }); }
  }
  if (mode === 'files_with_matches') return hits.slice(0, headLimit).map((h) => h.f).join('\n') || '(no matches)';
  if (mode === 'count') return hits.slice(0, headLimit).map((h) => `${h.f}:${h.c}`).join('\n') || '(no matches)';
  return lines.join('\n') || '(no matches)';
}

/** 실행기 — 인자·cwd만 받는 순수 사이드이펙트 함수들. 게이트 판정은 호출부(루프)가 먼저 한다. */
export function builtinRunners({ cwd, env = process.env, fetchImpl = globalThis.fetch }) {
  const senv = shellEnv(env);
  return {
    Read: async ({ file_path, offset, limit }) => {
      const txt = await readFile(abs(cwd, file_path), 'utf8');
      const all = txt.split('\n'); if (all.length > 1 && all.at(-1) === '') all.pop(); // 끝 개행은 빈 줄이 아니다
      const start = Math.max(0, Number(offset) || 0);
      const take = Math.min(Number(limit) > 0 ? Number(limit) : READ_LINE_CAP, READ_LINE_CAP);
      const body = all.slice(start, start + take).map((l, i) => `${start + i + 1}\t${l}`).join('\n');
      return cap(body + (all.length > start + take ? `\n…[${all.length - start - take} more lines]` : ''), OUT_CAP * 3);
    },
    Write: async ({ file_path, content }) => {
      const f = abs(cwd, file_path); await mkdir(dirname(f), { recursive: true }); await writeFile(f, String(content ?? ''));
      return `Wrote ${Buffer.byteLength(String(content ?? ''))} bytes to ${f}`;
    },
    Edit: async ({ file_path, old_string, new_string, replace_all }) => {
      const f = abs(cwd, file_path); const txt = await readFile(f, 'utf8');
      const n = txt.split(old_string).length - 1;
      if (n === 0) throw new Error('old_string not found');
      if (n > 1 && !replace_all) throw new Error(`old_string matches ${n} times — make it unique or set replace_all`);
      await writeFile(f, replace_all ? txt.split(old_string).join(new_string) : txt.replace(old_string, () => new_string));
      return `Edited ${f} (${replace_all ? n : 1} replacement${replace_all && n > 1 ? 's' : ''})`;
    },
    Glob: async ({ pattern, path }) => {
      const root = path ? abs(cwd, path) : cwd; const out = [];
      for await (const f of fsGlob(pattern, { cwd: root, exclude: (p) => SKIP_DIR_RE.test(p) })) { out.push(posix(f)); if (out.length >= 500) break; }
      return out.join('\n') || '(no matches)';
    },
    Grep: async (input) => {
      const root = input.path ? abs(cwd, input.path) : cwd;
      const re = new RegExp(input.pattern, input['-i'] ? 'i' : '');
      return cap(await grepJs(root, re, input.glob, input.output_mode || 'files_with_matches', Number(input.head_limit) > 0 ? Number(input.head_limit) : 200));
    },
    Bash: (input, { signal } = {}) => runBash(cwd, senv, input, signal),
    WebFetch: async ({ url }) => {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Argo/native-engine' } });
      const t = await r.text();
      const text = /html/i.test(r.headers.get('content-type') || '') ? t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : t;
      return cap(`HTTP ${r.status}\n${text}`, 50_000);
    },
  };
}
