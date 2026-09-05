// 네이티브 엔진 내장 도구 8종 — 이름·인자를 Claude Code 도구와 같게 둔다(Read·Write·Edit·Glob·Grep·Bash·WebFetch·WebSearch).
// 그래야 permission-gate(readToolTargets: file_path·path·pattern·glob·command)가 같은 판정을 한다.
// 하네스 통일의 요점: 어느 러너든 이 도구들이 같은 게이트를 지난다(SDK 경로는 allowedTools 항목이 게이트를 우회했다).
// 게이트는 1차 방어이고, 실행기 자체도 루트 봉쇄·경로형 인자 거절을 한다(분리 검수 CRITICAL-1: Grep glob이 게이트 밖이었다).
import { readFile, writeFile, mkdir, lstat, realpath, glob as fsGlob } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, isAbsolute, sep } from 'node:path';

const OUT_CAP = 30_000; // 도구 출력 상한(문자) — 모델 문맥 보호
const READ_LINE_CAP = 2000;
export const GREP_TIMEOUT_MS = 30_000;
/** 경로형 인자 판정(순수) — 절대경로·`~`·`..` 세그먼트. glob/pattern 자리에 오면 거절한다(루트 상대 필터만 허용). */
export const PATHY_GLOB_RE = /^(~|\/|[A-Za-z]:[\\/]|\\\\)|(^|[\\/])\.\.([\\/]|$)/;
export const SKIP_DIR_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)/; // 구분자 무관 제외(윈도우 경로는 백슬래시)

export const BUILTIN_SPECS = Object.freeze([
  { name: 'Read', description: 'Read a file from the filesystem. Returns numbered lines. Paths may be absolute or relative to the company folder. offset = 1-based line number to start from (default 1), limit = number of lines.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number', description: '1-based start line' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'Write', description: 'Write (create or overwrite) a file. Parent folders are created.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Glob', description: 'Find files by glob pattern relative to path (default: company folder), e.g. "**/*.md". The pattern must be relative (no absolute paths, ~ or ..). Returns up to 500 paths with "/" separators.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents with a regular expression under path (file or folder, default: company folder). glob = relative filename filter such as "**/*.md" (no absolute paths, ~ or ..). output_mode: content | files_with_matches | count.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, '-i': { type: 'boolean' }, head_limit: { type: 'number' } }, required: ['pattern'] } },
  { name: 'Bash', description: 'Run a shell command in the company folder. Output (stdout+stderr) is capped. timeout in ms (default 120000, max 600000).',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' }, description: { type: 'string' } }, required: ['command'] } },
  { name: 'WebFetch', description: 'Fetch a URL and return its raw text content (HTML tags stripped, capped at 50k chars). The prompt argument is accepted for compatibility but not applied — summarize the returned text yourself.',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string' } }, required: ['url'] } },
  { name: 'WebSearch', description: 'Search the web and return the top results (title, url, snippet). Use WebFetch on a result url to read it.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
]);

const cap = (s, n = OUT_CAP) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s);
const abs = (cwd, p) => (isAbsolute(String(p)) ? resolve(String(p)) : resolve(cwd, String(p)));
/** 도구 출력 경로는 OS 무관 `/` — 윈도우 fs.glob이 `a\x.md`를 돌려준다(CI windows-latest 실측 2026-09-05). sepChar 주입은 테스트용. */
export const posixify = (p, sepChar = sep) => String(p).split(sepChar).join('/');

/** Grep 워커 파일 경로 — 번들러(webpack)가 `new URL('./x', import.meta.url)`을 청크 에셋(/_next/NNNN.js)으로 재작성해 프로덕션·standalone에서
    MODULE_NOT_FOUND가 났다(재검수 NEW-HIGH-2). 런타임에 실재 파일을 찾는다: ① env 지정 ② cwd 기준 소스(레포 루트 `next start`·standalone의 nft 사본)
    ③ 실행 파일(server.js) 기준 ④ 소스 실행(테스트·dev)의 import.meta.url. import.meta.url 표현은 nft 추적(standalone 복사)용으로도 남긴다. */
export function grepWorkerPath({ env = process.env, cwd = process.cwd(), argv1 = process.argv[1] } = {}) {
  const rel = ['src', 'engine', 'grep-worker.mjs'];
  const candidates = [
    env.ARGO_GREP_WORKER,
    resolve(cwd, ...rel),
    argv1 ? resolve(dirname(argv1), ...rel) : null,
    (() => { try { return fileURLToPath(new URL('./grep-worker.mjs', import.meta.url)); } catch { return null; } })(),
  ].filter(Boolean);
  const hit = candidates.find((p) => { try { return existsSync(p); } catch { return false; } });
  if (!hit) throw new Error(`grep worker file not found — tried: ${candidates.join(' | ')}`);
  return hit;
}

/** 셸·MCP 자식 env — 러너 자격(ANTHROPIC_*·OAuth)은 크루 명령에 필요 없다. SDK 경로는 상속시켰지만 여기서는 뺀다(시크릿 규칙). */
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

/** Grep — 워커 스레드 + 시간 상한 + 정지 신호(분리 검수 MEDIUM-4). glob은 루트 상대 필터(CRITICAL-1). */
function runGrep({ cwd, timeoutMs }, input, signal) {
  return new Promise((res, rej) => {
    const root = input.path ? abs(cwd, input.path) : cwd;
    const glob = input.glob ? String(input.glob) : '';
    if (glob && PATHY_GLOB_RE.test(glob)) return rej(new Error('glob must be a relative filename filter (no absolute paths, ~ or ..)'));
    let re; try { re = new RegExp(String(input.pattern), input['-i'] ? 'i' : ''); } catch (e) { return rej(new Error(`invalid regex: ${e.message}`)); }
    let file; try { file = grepWorkerPath(); } catch (e) { return rej(e); }
    const w = new Worker(file, { workerData: {
      root, pattern: re.source, flags: re.flags, glob, mode: input.output_mode || 'files_with_matches', headLimit: Number(input.head_limit) > 0 ? Number(input.head_limit) : 200,
    } });
    let done = false;
    const end = (fn) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); };
    const timer = setTimeout(() => end(() => { w.terminate(); rej(new Error(`grep timed out after ${timeoutMs}ms — simplify the pattern or narrow path/glob`)); }), timeoutMs);
    const onAbort = () => end(() => { w.terminate(); rej(Object.assign(new Error('aborted'), { aborted: true })); });
    signal?.addEventListener('abort', onAbort, { once: true });
    w.once('message', (m) => end(() => (m.ok ? res(cap(m.text)) : rej(new Error(m.error)))));
    w.once('error', (e) => end(() => rej(e)));
  });
}

/** DuckDuckGo HTML 결과 파서(순수) — [{title,url,snippet}] 최대 8건. 리다이렉트 링크(uddg=)는 원 URL로 푼다. */
export function parseSearchResults(html) {
  const out = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  const strip = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
  let m;
  while ((m = re.exec(html)) && out.length < 8) {
    let url = m[1].replace(/&amp;/g, '&');
    const uddg = url.match(/[?&]uddg=([^&]+)/); if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* 원문 유지 */ } }
    if (url.startsWith('//')) url = `https:${url}`;
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  return out;
}

/** 실행기 — 인자·cwd만 받는 사이드이펙트 함수들. 게이트 판정은 호출부(루프)가 먼저 한다. */
export function builtinRunners({ cwd, env = process.env, fetchImpl = globalThis.fetch, grepTimeoutMs = GREP_TIMEOUT_MS, searchBase = 'https://html.duckduckgo.com/html/?q=' }) {
  const senv = shellEnv(env);
  const rootAbs = resolve(cwd);
  return {
    Read: async ({ file_path, offset, limit }) => {
      const txt = await readFile(abs(cwd, file_path), 'utf8');
      const all = txt.split('\n'); if (all.length > 1 && all.at(-1) === '') all.pop(); // 끝 개행은 빈 줄이 아니다
      const start = Math.max(0, (Number(offset) || 1) - 1); // Claude Code와 같은 1-based(분리 검수 LOW)
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
      if (PATHY_GLOB_RE.test(String(pattern))) throw new Error('pattern must be relative to path (no absolute paths, ~ or ..)');
      const root = path ? abs(cwd, path) : rootAbs; const out = [];
      const rootReal = await realpath(root).catch(() => root);
      // 루트 봉쇄는 실경로 기준 + 심링크 항목 미노출(재검수 NEW-HIGH-1 — 렉시컬 resolve는 심링크를 못 본다, rg·SDK Glob 기본 미추종과 같은 계약)
      for await (const f of fsGlob(pattern, { cwd: root, exclude: (p) => SKIP_DIR_RE.test(p) })) {
        const a = resolve(root, f);
        const ls = await lstat(a).catch(() => null); if (!ls || ls.isSymbolicLink()) continue;
        const r = await realpath(a).catch(() => null); if (!r || !(r === rootReal || r.startsWith(rootReal + sep))) continue;
        out.push(posixify(f)); if (out.length >= 500) break;
      }
      return out.join('\n') || '(no matches)';
    },
    Grep: (input, { signal } = {}) => runGrep({ cwd, timeoutMs: grepTimeoutMs }, input, signal),
    Bash: (input, { signal } = {}) => runBash(cwd, senv, input, signal),
    WebFetch: async ({ url }) => {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Argo/native-engine' } });
      const t = await r.text();
      const text = /html/i.test(r.headers.get('content-type') || '') ? t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : t;
      return cap(`HTTP ${r.status}\n${text}`, 50_000);
    },
    WebSearch: async ({ query }) => {
      const r = await fetchImpl(`${searchBase}${encodeURIComponent(String(query))}`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 (Argo native engine)' } });
      const results = parseSearchResults(await r.text());
      return results.length ? results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n') : `(no results, HTTP ${r.status})`;
    },
  };
}
