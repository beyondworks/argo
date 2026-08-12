// Qwen/OpenAI 호환 러너의 네이티브 도구 레지스트리.
// 기존 permission-gate를 단일 권한 정본으로 사용하고 OpenAI function schema로 노출한다.
import { exec as childExec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { makePermissionGate, suggestCapability } from './permission-gate.mjs';
import { makeCrewActions } from './crew-actions.mjs';
import { addApproval } from './approvals.mjs';
import { addRoutine } from './routines.mjs';
import { installMcp, importHostMcp } from './market.mjs';
import { RUNNERS, runnerStatus } from './runners.mjs';
import { scrubServerSecrets } from './runners/shared.mjs';
import { writeFileAtomic } from './jsonstore.mjs';
import { scraplingWebFetch, scraplingWebSearch } from './scrapling.mjs';
import { connectOpenAICompatMcpTools } from './openai-compat-mcp.mjs';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 120_000;
const MAX_LIST_RESULTS = 1000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_VISITS = 5000;

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });
const arr = (items, description) => ({ type: 'array', items, description });

const cleanText = (value, max = MAX_TOOL_OUTPUT) => String(value ?? '').slice(0, max);
const toAbs = (root, value) => isAbsolute(String(value ?? '')) ? resolve(String(value)) : resolve(root, String(value ?? ''));
const inside = (target, root) => target === root || target.startsWith(`${root}${sep}`);
const appearsBinary = (buf) => buf.subarray(0, 8192).includes(0);

async function resolvedPath(path, { mustExist = true } = {}) {
  const abs = resolve(path);
  if (mustExist) return realpath(abs);
  let cursor = abs;
  const suffix = [];
  while (true) {
    try {
      const base = await realpath(cursor);
      return resolve(base, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

function shellEnv() {
  const env = scrubServerSecrets(process.env, 'terminal');
  for (const key of Object.keys(env)) {
    if (key.startsWith('ARGO_') || key.startsWith('SUPABASE_') || key.startsWith('NEXT_PUBLIC_')) delete env[key];
  }
  return { ...env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' };
}

function execShell(command, { cwd, env, timeout, signal }) {
  return new Promise((resolveCommand, rejectCommand) => {
    if (signal?.aborted) { rejectCommand(signal.reason || new DOMException('중단됨', 'AbortError')); return; }
    let settled = false;
    let timeoutTimer;
    const child = childExec(command, {
      cwd, env, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
      detached: process.platform !== 'win32',
    }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectCommand(Object.assign(error, { stdout, stderr }));
      else resolveCommand({ stdout, stderr });
    });
    const cleanup = () => {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', abort);
    };
    const killGroup = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {}
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const hardKill = setTimeout(() => {
        if (child.exitCode !== null) return;
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {}
      }, 1000);
      hardKill.unref?.();
    };
    const stop = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      killGroup();
      rejectCommand(error);
    };
    const abort = () => stop(signal?.reason instanceof Error ? signal.reason : new DOMException('중단됨', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    timeoutTimer = setTimeout(() => stop(Object.assign(new Error('명령 시간 초과'), { code: 'ETIMEDOUT' })), timeout);
    if (signal?.aborted) abort();
  });
}

async function readTextFile(path) {
  const info = await stat(path);
  if (!info.isFile()) throw new Error('파일이 아니다.');
  if (info.size > MAX_FILE_BYTES) throw new Error(`파일이 너무 크다(${info.size} bytes, 최대 ${MAX_FILE_BYTES}).`);
  const body = await readFile(path);
  if (appearsBinary(body)) throw new Error('바이너리 파일은 텍스트 도구로 읽을 수 없다.');
  return { body, info };
}

async function walkFiles(base, { recursive = true, maxVisits = MAX_SEARCH_VISITS } = {}) {
  const root = await realpath(base);
  const queue = [''];
  const files = [];
  let visits = 0;
  while (queue.length && visits < maxVisits && files.length < MAX_LIST_RESULTS) {
    const rel = queue.shift();
    const abs = rel ? resolve(root, rel) : root;
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visits += 1;
      if (visits > maxVisits) break;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = resolve(root, ...childRel.split('/'));
      const real = await realpath(child).catch(() => null);
      if (!real || !inside(real, root)) continue;
      if (entry.isDirectory()) {
        if (recursive && !entry.isSymbolicLink()) queue.push(childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push({ rel: childRel, abs: real });
        if (files.length >= MAX_LIST_RESULTS) break;
      }
    }
  }
  return { root, files, limited: queue.length > 0 || visits >= maxVisits || files.length >= MAX_LIST_RESULTS };
}

function nativeTool(name, canonicalName, description, parameters, gateInput, execute) {
  return {
    definition: { type: 'function', function: { name, description, parameters } },
    canonicalName,
    gateInput,
    execute,
  };
}

export const OPENAI_COMPAT_NATIVE_TOOL_NAMES = [
  'read_file', 'list_files', 'search_files', 'write_file', 'edit_file', 'apply_patch', 'run_command',
  'web_search', 'web_fetch', 'request_approval', 'request_capability', 'request_tool_install',
  'update_profile', 'hire_crew', 'schedule_task', 'start_long_task', 'delegate', 'send_to_crew',
];

/** context는 chat 턴에서 만든 테넌트·크루 범위다. */
export async function createOpenAICompatToolRegistry(context, { mcpServers = {}, onWarning = () => {}, signal = null } = {}) {
  const {
    wsId, agentSlug, agentName, root, vaultRoot, caps, workRoots = [], from = null,
    lang = 'ko', colleagues = [], hop = 0, chain = [], mirrorCtx = null,
    onArtifact = () => {}, runChat,
  } = context;
  const gate = makePermissionGate(wsId, agentSlug, caps, root, chain.length ? chain[chain.length - 1] : from, lang, workRoots);
  const delegatedBy = chain.length ? chain[chain.length - 1] : null;
  const readEvidence = new Map();
  const addReadCoverage = (abs, { sha256, size, totalLines, start, end }) => {
    const key = abs.normalize('NFC');
    const previous = readEvidence.get(key);
    const ranges = previous?.sha256 === sha256 ? [...previous.ranges, [start, end]] : [[start, end]];
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    const complete = merged.length === 1 && merged[0][0] === 1 && merged[0][1] >= totalLines;
    readEvidence.set(key, { path: abs, sha256, size, totalLines, ranges: merged, complete });
  };
  const crew = makeCrewActions(
    { wsId, fromSlug: agentSlug, fromName: agentName || agentSlug, colleagues, hop, chain, mirrorCtx, lang },
    { runChat },
  );
  const findCrew = (value) => {
    const key = String(value ?? '').normalize('NFC').toLowerCase().trim();
    if (!key || key === 'me' || key === agentSlug || key === String(agentName).toLowerCase()) return { slug: agentSlug, name: agentName || agentSlug };
    return colleagues.find((a) => a.slug === key || String(a.name).normalize('NFC').toLowerCase() === key) ?? null;
  };

  const tools = [
    nativeTool('read_file', 'Read', '파일을 읽는다. path는 회사 폴더 기준 상대경로 또는 허용된 절대경로다. 큰 파일은 offset/limit으로 나눠 읽어라.', schema({
      path: str('파일 경로'), offset: num('시작 줄(1부터, 기본 1)'), limit: num('읽을 줄 수(최대 10000)'),
    }, ['path']), async (a) => ({ file_path: await resolvedPath(toAbs(root, a.path)) }), async (a, gateArgs) => {
      const abs = gateArgs.file_path;
      const { body } = await readTextFile(abs);
      const lines = body.toString('utf8').split(/\r?\n/);
      const offset = Math.max(1, Math.floor(Number(a.offset) || 1));
      const limit = Math.max(1, Math.min(10_000, Math.floor(Number(a.limit) || 400)));
      if (offset > lines.length) throw new Error(`시작 줄이 파일 범위를 벗어났다(${offset}, 전체 ${lines.length}줄).`);
      const selected = lines.slice(offset - 1, offset - 1 + limit)
        .map((line, i) => `${offset + i}: ${line}`).join('\n');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const end = Math.min(lines.length, offset + limit - 1);
      const output = `${abs}\nsha256:${sha256}\nsize:${body.length}\n${selected}\n\n[lines ${offset}-${end} of ${lines.length}]`;
      if (output.length > MAX_TOOL_OUTPUT) {
        throw new Error(`읽기 결과가 도구 출력 상한을 넘었다(${output.length}자, 최대 ${MAX_TOOL_OUTPUT}). limit을 줄여 다시 읽어라.`);
      }
      addReadCoverage(abs, { sha256, size: body.length, totalLines: lines.length, start: offset, end });
      return output;
    }),

    nativeTool('list_files', 'Glob', '폴더 안 파일을 열거한다. 회사 전체가 아니라 vault/, skills/ 또는 구체적 작업 폴더를 지정하라.', schema({
      path: str('검색할 폴더 경로'), recursive: bool('하위 폴더까지 재귀 탐색(기본 true)'),
    }, ['path']), async (a) => {
      const path = await resolvedPath(toAbs(root, a.path));
      return { path, pattern: `${path}${sep}**` };
    }, async (a, gateArgs) => {
      const abs = gateArgs.path;
      const info = await stat(abs);
      if (!info.isDirectory()) throw new Error('폴더가 아니다.');
      const found = await walkFiles(abs, { recursive: a.recursive !== false });
      return `${found.files.map((f) => f.rel).join('\n')}${found.limited ? '\n[결과 상한에 도달함]' : ''}` || '[빈 폴더]';
    }),

    nativeTool('search_files', 'Grep', '여러 텍스트 파일에서 문자열 또는 정규식을 검색한다. 반드시 vault/, skills/ 또는 구체적 폴더를 지정하라.', schema({
      query: str('찾을 문자열 또는 정규식'), path: str('검색할 폴더 경로'), regex: bool('query를 정규식으로 처리'), case_sensitive: bool('대소문자 구분'),
    }, ['query', 'path']), async (a) => ({ pattern: a.query, path: await resolvedPath(toAbs(root, a.path)) }), async (a, gateArgs) => {
      const abs = gateArgs.path;
      const found = await walkFiles(abs, { recursive: true });
      const flags = a.case_sensitive ? 'g' : 'gi';
      const matcher = a.regex ? new RegExp(String(a.query), flags) : null;
      const needle = a.case_sensitive ? String(a.query) : String(a.query).toLowerCase();
      const results = [];
      for (const file of found.files) {
        if (results.length >= MAX_SEARCH_RESULTS) break;
        const info = await stat(file.abs).catch(() => null);
        if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
        const body = await readFile(file.abs).catch(() => null);
        if (!body || appearsBinary(body)) continue;
        const lines = body.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i += 1) {
          const line = lines[i];
          const hit = matcher ? (matcher.lastIndex = 0, matcher.test(line)) : (a.case_sensitive ? line : line.toLowerCase()).includes(needle);
          if (hit) results.push(`${file.rel}:${i + 1}: ${line.slice(0, 500)}`);
        }
      }
      return results.join('\n') || '[일치 없음]';
    }),

    nativeTool('write_file', 'Write', '텍스트 파일을 새로 만들거나 전체 내용을 덮어쓴다. 기존 파일의 일부만 바꿀 때는 edit_file을 사용하라.', schema({
      path: str('파일 경로'), content: str('저장할 전체 텍스트'),
    }, ['path', 'content']), async (a) => ({ file_path: await resolvedPath(toAbs(root, a.path), { mustExist: false }), content: a.content }), async (a, gateArgs) => {
      const abs = gateArgs.file_path;
      const body = Buffer.from(String(a.content), 'utf8');
      if (body.length > MAX_FILE_BYTES) throw new Error('저장 내용이 너무 크다.');
      await mkdir(dirname(abs), { recursive: true });
      const old = await stat(abs).catch(() => null);
      await writeFileAtomic(abs, body, { mode: old?.mode ? old.mode & 0o777 : 0o644 });
      if (inside(abs, resolve(vaultRoot))) onArtifact(relative(resolve(vaultRoot), abs).split(sep).join('/'));
      return `저장함: ${abs} (${body.length} bytes)`;
    }),

    nativeTool('edit_file', 'Edit', '파일에서 정확히 일치하는 문자열을 교체한다. replace_all=false일 때 old_text는 정확히 한 번만 있어야 한다.', schema({
      path: str('파일 경로'), old_text: str('교체 전 정확한 문자열'), new_text: str('교체 후 문자열'), replace_all: bool('모든 일치를 교체'),
    }, ['path', 'old_text', 'new_text']), async (a) => ({ file_path: await resolvedPath(toAbs(root, a.path)), old_string: a.old_text, new_string: a.new_text }), async (a, gateArgs) => {
      const abs = gateArgs.file_path;
      const { body, info } = await readTextFile(abs);
      const text = body.toString('utf8');
      const oldText = String(a.old_text);
      if (!oldText) throw new Error('old_text는 비울 수 없다.');
      const count = text.split(oldText).length - 1;
      if (!count) throw new Error('old_text를 파일에서 찾지 못했다.');
      if (!a.replace_all && count !== 1) throw new Error(`old_text가 ${count}번 나타난다. 더 긴 문맥을 지정하거나 replace_all을 사용하라.`);
      const updated = a.replace_all ? text.split(oldText).join(String(a.new_text)) : text.replace(oldText, String(a.new_text));
      await writeFileAtomic(abs, updated, { mode: info.mode & 0o777 });
      if (inside(abs, resolve(vaultRoot))) onArtifact(relative(resolve(vaultRoot), abs).split(sep).join('/'));
      return `수정함: ${abs} (${a.replace_all ? count : 1}개 교체)`;
    }),

    nativeTool('apply_patch', 'Edit', '한 파일에 여러 exact-text 편집을 순서대로 적용하고 마지막에 한 번만 원자적으로 저장한다.', schema({
      path: str('파일 경로'),
      edits: arr({
        type: 'object',
        properties: { old_text: str('교체 전 정확한 문자열'), new_text: str('교체 후 문자열') },
        required: ['old_text', 'new_text'], additionalProperties: false,
      }, '순서대로 적용할 편집 목록'),
    }, ['path', 'edits']), async (a) => ({ file_path: await resolvedPath(toAbs(root, a.path)), edits: a.edits }), async (a, gateArgs) => {
      const abs = gateArgs.file_path;
      const { body, info } = await readTextFile(abs);
      if (!Array.isArray(a.edits) || !a.edits.length || a.edits.length > 50) throw new Error('edits는 1~50개여야 한다.');
      let updated = body.toString('utf8');
      for (let i = 0; i < a.edits.length; i += 1) {
        const oldText = String(a.edits[i]?.old_text ?? '');
        const newText = String(a.edits[i]?.new_text ?? '');
        if (!oldText) throw new Error(`edits[${i}].old_text는 비울 수 없다.`);
        const count = updated.split(oldText).length - 1;
        if (count !== 1) throw new Error(`edits[${i}].old_text가 ${count}번 나타난다. 각 편집은 정확히 한 곳과 일치해야 한다.`);
        updated = updated.replace(oldText, newText);
      }
      if (Buffer.byteLength(updated, 'utf8') > MAX_FILE_BYTES) throw new Error('수정 결과가 너무 크다.');
      await writeFileAtomic(abs, updated, { mode: info.mode & 0o777 });
      if (inside(abs, resolve(vaultRoot))) onArtifact(relative(resolve(vaultRoot), abs).split(sep).join('/'));
      return `패치 적용함: ${abs} (${a.edits.length}개 편집)`;
    }),

    nativeTool('run_command', 'Bash', '회사 폴더를 작업 디렉터리로 셸 명령을 실행한다. shell 능력이 켜져 있어야 하며 서버·모델 자격은 환경에서 제거된다.', schema({
      command: str('실행할 셸 명령'), cwd: str('작업 폴더(기본 회사 폴더)'), timeout_seconds: num('시간 제한 초(최대 600)'),
    }, ['command']), (a) => ({ command: String(a.command) }), async (a, _gateArgs, { signal = null } = {}) => {
      const cwd = await resolvedPath(a.cwd ? toAbs(root, a.cwd) : resolve(root));
      const cwdGate = await gate('Read', { file_path: cwd });
      if (cwdGate.behavior !== 'allow') return `도구 거부: ${cwdGate.message}`;
      if (!(await stat(cwd)).isDirectory()) throw new Error('cwd가 폴더가 아니다.');
      const command = String(a.command).trim();
      if (!command || command.length > 20_000) throw new Error('유효한 command가 필요하다.');
      const timeout = Math.max(1, Math.min(600, Math.floor(Number(a.timeout_seconds) || 30))) * 1000;
      try {
        const { stdout, stderr } = await execShell(command, { cwd, env: shellEnv(), timeout, signal });
        return cleanText([stdout, stderr].filter(Boolean).join('\n')) || '[명령 성공, 출력 없음]';
      } catch (error) {
        return cleanText(`명령 실패(exit ${error?.code ?? '?'}):\n${error?.stdout || ''}\n${error?.stderr || error?.message || error}`);
      }
    }),

    nativeTool('web_search', 'WebSearch', 'Scrapling으로 웹 검색을 수행하고 제목과 원문 URL을 반환한다.', schema({
      query: str('검색어'), limit: num('결과 수(1~10)'),
    }, ['query']), (a) => ({ query: a.query }), async (a, _gateArgs, { signal = null } = {}) => scraplingWebSearch(a.query, { limit: a.limit, signal })),

    nativeTool('web_fetch', 'WebFetch', 'Scrapling으로 공개 웹 페이지를 가져와 Markdown으로 변환한다. localhost와 사설망은 차단된다.', schema({
      url: str('http/https URL'),
    }, ['url']), (a) => ({ url: a.url }), async (a, _gateArgs, { signal = null } = {}) => scraplingWebFetch(a.url, { signal })),

    nativeTool('request_approval', 'mcp__crew__request_approval', '발송·게시·구매·삭제·계약처럼 회사 밖으로 나가거나 되돌리기 어려운 행동 전에 사장 결재를 요청한다.', schema({
      action: str('하려는 행동'), reason: str('필요한 이유'),
    }, ['action', 'reason']), null, async (a) => {
      const item = await addApproval(wsId, { slug: agentSlug, ...(delegatedBy ? { from: delegatedBy } : {}), action: cleanText(a.action, 500), reason: cleanText(a.reason, 2000) });
      return `결재 요청을 등록했다(${item.id}). 승인 전에는 행동을 실행하지 마라.`;
    }),

    nativeTool('request_capability', 'mcp__crew__request_capability', '꺼져 있는 로컬 능력(fs/browser/shell)을 사장에게 요청한다.', schema({
      cap: { type: 'string', enum: ['fs', 'browser', 'shell'] }, why: str('필요한 이유'),
    }, ['cap', 'why']), null, async (a) => {
      const item = await suggestCapability(wsId, agentSlug, a.cap, cleanText(a.why, 2000), delegatedBy);
      return `능력 요청을 등록했다${item ? `(${item.id})` : ''}. 승인되면 다음 턴에서 이어서 실행하라.`;
    }),

    nativeTool('request_tool_install', 'mcp__crew__request_tool_install', '필요한 MCP 도구가 없을 때 카탈로그 또는 호스트에서 설치를 요청한다.', schema({
      source: { type: 'string', enum: ['catalog', 'host'] }, id: str('도구 id 또는 호스트 MCP 이름'), why: str('필요한 이유'),
    }, ['source', 'id', 'why']), null, async (a) => {
      const id = String(a.id).replace(/[\r\n\t\x00-\x1f]+/g, ' ').trim().slice(0, 64);
      if (caps.bypass) {
        const result = a.source === 'host' ? await importHostMcp(wsId, id) : await installMcp(wsId, id);
        return `도구를 설치했다: ${result?.name || id}. 다음 턴부터 사용할 수 있다.`;
      }
      const item = await addApproval(wsId, {
        slug: agentSlug, kind: 'mcp', ...(delegatedBy ? { from: delegatedBy } : {}),
        action: `도구 설치: ${id}`, reason: cleanText(a.why, 2000), payload: { source: a.source, id },
      });
      return `도구 설치 결재를 등록했다(${item.id}). 승인 전에는 그 도구를 사용하지 마라.`;
    }),

    nativeTool('update_profile', 'mcp__crew__update_profile', '자기 자신 또는 동료 크루의 이름·역할·팀·러너·모델·규칙 변경을 사장 결재로 올린다.', schema({
      target: str('me 또는 크루 이름/slug'), name: str('새 이름'), role: str('새 역할'), team: str('새 팀'), rule: str('추가할 업무 규칙'),
      runner: str('러너 id'), model: str('모델 id'), why: str('변경 이유'),
    }, ['target', 'why']), null, async (a) => {
      const who = findCrew(a.target);
      if (!who) return `대상 크루를 찾을 수 없다: ${a.target}`;
      let runner = a.runner || undefined;
      const model = a.model || undefined;
      if (model && !runner) runner = Object.keys(RUNNERS).find((id) => RUNNERS[id].models.some((m) => m.id === model));
      if (runner && !RUNNERS[runner]) return `알 수 없는 러너: ${runner}`;
      if (model && (!runner || !RUNNERS[runner].models.some((m) => m.id === model))) return `러너와 모델 조합이 카탈로그에 없다: ${runner || '?'} / ${model}`;
      if (runner) {
        const st = await runnerStatus(wsId).catch(() => null);
        if (st?.[runner] && !st[runner].company.connected && !st[runner].hostAuthed) return `${RUNNERS[runner].name} 러너가 연결되지 않았다.`;
      }
      const changes = Object.fromEntries(['name', 'role', 'team'].filter((k) => a[k] !== undefined).map((k) => [k, cleanText(a[k], 500)]));
      if (runner) changes.runner = runner;
      if (model) changes.model = model;
      if (!Object.keys(changes).length && !a.rule) return '변경할 내용이 없다.';
      const item = await addApproval(wsId, {
        slug: agentSlug, kind: 'profile', ...(delegatedBy ? { from: delegatedBy } : {}),
        action: `프로필 변경 — ${who.name}`, reason: cleanText(a.why, 2000),
        payload: { slug: who.slug, changes, ...(a.rule ? { rule: cleanText(a.rule, 2000) } : {}) },
      });
      return `프로필 변경 결재를 등록했다(${item.id}).`;
    }),

    nativeTool('hire_crew', 'mcp__crew__hire_crew', '새 크루 영입을 사장 결재로 올린다.', schema({
      brief: str('맡길 역할과 전문성'), name: str('이름'), team: str('팀'), runner: str('러너 id'), model: str('모델 id'), why: str('영입 이유'),
    }, ['brief', 'why']), null, async (a) => {
      const runner = a.runner || undefined;
      const model = a.model || undefined;
      if (runner && !RUNNERS[runner]) return `알 수 없는 러너: ${runner}`;
      if (model && (!runner || !RUNNERS[runner].models.some((m) => m.id === model))) return `러너와 모델 조합이 카탈로그에 없다.`;
      const item = await addApproval(wsId, {
        slug: agentSlug, kind: 'hire', ...(delegatedBy ? { from: delegatedBy } : {}),
        action: `크루 영입 — ${a.name ? `${cleanText(a.name, 200)}: ` : ''}${cleanText(a.brief, 1000)}`,
        reason: cleanText(a.why, 2000), payload: {
          brief: cleanText(a.brief, 1000), ...(a.name ? { name: cleanText(a.name, 200) } : {}),
          ...(a.team ? { team: cleanText(a.team, 200) } : {}), ...(runner ? { runner } : {}), ...(model ? { model } : {}),
        },
      });
      return `크루 영입 결재를 등록했다(${item.id}).`;
    }),

    nativeTool('schedule_task', 'mcp__crew__schedule_task', '1회·매일·매주·간격 반복 작업을 예약한다.', schema({
      title: str('예약 이름'), prompt: str('실행할 지시'), type: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'] },
      time: str('HH:MM'), every_minutes: num('interval 간격 10~1440분'), date: str('once 날짜 YYYY-MM-DD'), dows: arr({ type: 'number' }, '요일 0=일~6=토'), agent_slug: str('담당 크루 slug'),
    }, ['title', 'prompt', 'type']), null, async (a) => {
      const routine = await addRoutine(wsId, {
        agentSlug: a.agent_slug || agentSlug, title: String(a.title), prompt: String(a.prompt),
        schedule: { type: a.type, ...(a.time ? { time: a.time } : {}), ...(a.date ? { date: a.date } : {}), ...(a.dows?.length ? { dows: a.dows } : {}), ...(a.every_minutes ? { everyMinutes: a.every_minutes } : {}) },
      });
      return `예약 완료: ${routine.title} (${routine.id})`;
    }),

    nativeTool('start_long_task', 'mcp__crew__start_long_task', '10분을 넘길 수 있는 작업을 백그라운드 큐에 적재한다.', schema({
      title: str('작업 이름'), prompt: str('별도 턴이 단독으로 이해할 상세 지시'), agent_slug: str('담당 크루 slug'),
    }, ['title', 'prompt']), null, async (a) => {
      const { enqueueLongJob } = await import('./gateway.mjs');
      const result = await enqueueLongJob(wsId, { slug: a.agent_slug || agentSlug, title: String(a.title), prompt: String(a.prompt) });
      return `장시간 작업을 적재했다: ${a.title} (대기·진행 ${result.pending}건)`;
    }),

    nativeTool('delegate', 'mcp__crew__delegate', '동료 크루에게 구체적인 하위 작업을 위임하고 결과를 기다린다.', schema({
      to: str('동료 slug'), task: str('독립 수행 가능한 구체적 지시'),
    }, ['to', 'task']), null, async (a) => crew.delegate(a)),

    nativeTool('send_to_crew', 'mcp__crew__send_to_crew', '동료 크루에게 비동기 쪽지를 보낸다. 즉시 결과가 필요하면 delegate를 사용한다.', schema({
      to: str('동료 slug'), cc: arr({ type: 'string' }, '참조 동료 slug'), message: str('쪽지 내용'),
    }, ['to', 'message']), null, async (a) => crew.sendToCrew(a)),
  ];

  const mcp = await connectOpenAICompatMcpTools(mcpServers, { cwd: root, onWarning, signal });
  tools.push(...mcp.tools);
  const byName = new Map(tools.map((item) => [item.definition.function.name, item]));

  return {
    definitions: tools.map((item) => item.definition),
    canonicalName: (name) => byName.get(name)?.canonicalName || name,
    hasReadEvidence: async (path) => {
      const key = resolve(String(path)).normalize('NFC');
      const item = readEvidence.get(key);
      if (!item?.complete) return false;
      const body = await readFile(key).catch(() => null);
      return !!body && body.length === item.size
        && createHash('sha256').update(body).digest('hex') === item.sha256;
    },
    readEvidence: () => [...readEvidence.values()].filter((item) => item.complete)
      .map(({ ranges: _ranges, complete: _complete, totalLines: _totalLines, ...item }) => ({ ...item })),
    async execute(name, args = {}, executionContext = {}) {
      const item = byName.get(name);
      if (!item) return `알 수 없는 도구: ${name}`;
      try {
        if (item.gateInput) {
          const gateArgs = await item.gateInput(args);
          const decision = await gate(item.canonicalName, gateArgs);
          if (decision.behavior !== 'allow') return `도구 거부: ${decision.message}`;
          return cleanText(await item.execute(args, gateArgs, executionContext));
        } else if (item.canonicalName.startsWith('mcp__') && !item.canonicalName.startsWith('mcp__crew__')) {
          const decision = await gate(item.canonicalName, args);
          if (decision.behavior !== 'allow') return `도구 거부: ${decision.message}`;
        }
        return cleanText(await item.execute(args, null, executionContext));
      } catch (error) {
        return cleanText(`도구 오류(${name}): ${String(error?.message || error)}`);
      }
    },
    close: mcp.close,
  };
}
