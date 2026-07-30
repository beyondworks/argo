// Codex식 우측 도구 패널이 쓰는 파일 루트/경로 관문.
// 회사 워크스페이스와 사장이 설정에서 등록한 외부 작업 폴더만 열고, 경로 탈출·심링크 탈출과
// 회사 루트 직속 도트파일(.secrets.json 등)은 UI에서도 에이전트 도구와 같은 경계로 차단한다.
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeFileAtomic } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { loadCompany, paths } from './workspace.mjs';
import { loadActiveWorkRoots } from './workroots.mjs';

export const MAX_TOOL_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOOL_RAW_BYTES = 20 * 1024 * 1024;
export const MAX_TOOL_DIR_ENTRIES = 1000;
export const MAX_TOOL_SEARCH_RESULTS = 120;
export const MAX_TOOL_SEARCH_VISITS = 5000;

const TEXT_EXTS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.graphql', '.h', '.hpp',
  '.htm', '.html', '.ini', '.java', '.js', '.jsx', '.json', '.jsonl', '.kt', '.log', '.md', '.mjs',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt',
  '.vue', '.xml', '.yaml', '.yml', '.zsh',
]);
// SVG는 이미지 태그에서도 직접 열기/다운로드 경로가 같은 출처가 되므로 코드 텍스트로 다룬다.
// 스크립트가 없는 래스터 형식만 이미지 문서로 연다.
const IMAGE_EXTS = new Set(['.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.webp']);
const MIME = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
};

const toolError = (code, status = 400) => Object.assign(new Error(code), { code, status });
const inside = (target, root) => target === root || target.startsWith(`${root}${sep}`);
const externalId = (root) => `work-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`;
const fileVersion = (body) => createHash('sha256').update(body).digest('hex');

/** 열린 파일을 어떤 문서 뷰로 보여줄지 서버에서 확정해 클라이언트의 확장자 추측을 없앤다. */
export function workspaceFileRenderer(input = '') {
  const ext = extname(String(input)).toLowerCase();
  if (ext === '.md') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'source';
}

/** 브라우저가 보내는 경로는 항상 루트 기준 POSIX 상대경로다. */
export function normalizeToolRelative(input = '') {
  if (typeof input !== 'string' || input.includes('\0') || input.includes('\\') || isAbsolute(input)) {
    throw toolError('invalid-path');
  }
  const trimmed = input.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const parts = trimmed.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw toolError('invalid-path');
  return parts.join('/');
}

/** 루트 ID는 경로 자체 대신 안정 해시를 쓴다. 요청마다 등록 목록과 다시 대조해 임의 절대경로 주입을 막는다. */
export async function listWorkspaceToolRoots(wsId) {
  const company = await loadCompany(wsId);
  const companyRoot = await realpath(paths(wsId).root);
  const workRoots = await loadActiveWorkRoots(wsId);
  return [
    {
      id: 'company',
      kind: 'company',
      label: company.name || wsId,
      location: companyRoot,
      root: companyRoot,
    },
    ...workRoots.map((root) => ({
      id: externalId(root),
      kind: 'workroot',
      label: basename(root) || root,
      location: root,
      root,
    })),
  ];
}

export async function resolveWorkspaceToolRoot(wsId, rootId = 'company') {
  const roots = await listWorkspaceToolRoots(wsId);
  const found = roots.find((root) => root.id === rootId);
  if (!found) throw toolError('unknown-root', 404);
  return found;
}

/** 존재하는 대상만 연다. realpath를 루트와 함께 비교하므로 등록 폴더 안 심링크를 통한 탈출도 차단된다. */
export async function resolveWorkspaceToolPath(wsId, rootId, input = '') {
  const root = await resolveWorkspaceToolRoot(wsId, rootId);
  const rel = normalizeToolRelative(input);
  const first = rel.split('/')[0] || '';
  if (root.kind === 'company' && first.startsWith('.')) throw toolError('protected-path', 403);

  const abs = rel ? join(root.root, ...rel.split('/')) : root.root;
  const real = await realpath(abs).catch(() => null);
  if (!real) throw toolError('not-found', 404);
  if (!inside(real, root.root)) throw toolError('protected-path', 403);
  return { root, rel, abs: real, info: await stat(real) };
}

async function safeEntry(root, parentRel, dirent) {
  if (root.kind === 'company' && !parentRel && dirent.name.startsWith('.')) return null;
  const rel = parentRel ? `${parentRel}/${dirent.name}` : dirent.name;
  const abs = join(root.root, ...rel.split('/'));
  const real = await realpath(abs).catch(() => null);
  if (!real || !inside(real, root.root)) return null;
  const info = await stat(real).catch(() => null);
  if (!info) return null;
  return {
    name: dirent.name,
    path: rel,
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    size: info.isFile() ? info.size : null,
    mtime: info.mtimeMs,
    symlink: dirent.isSymbolicLink(),
  };
}

export async function listWorkspaceDirectory(wsId, rootId, input = '') {
  const target = await resolveWorkspaceToolPath(wsId, rootId, input);
  if (!target.info.isDirectory()) throw toolError('not-directory');
  const dirents = await readdir(target.abs, { withFileTypes: true });
  if (dirents.length > MAX_TOOL_DIR_ENTRIES) throw toolError('too-many-entries', 413);
  const entries = (await Promise.all(dirents.map((entry) => safeEntry(target.root, target.rel, entry))))
    .filter((entry) => entry && entry.type !== 'other')
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  return { root: publicRoot(target.root), path: target.rel, entries };
}

const appearsBinary = (buf) => {
  const length = Math.min(buf.length, 8192);
  if (!length) return false;
  let controls = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = buf[i];
    if (byte === 0) return true;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / length > 0.08;
};

export async function openWorkspaceToolFile(wsId, rootId, input) {
  const target = await resolveWorkspaceToolPath(wsId, rootId, input);
  if (!target.info.isFile()) throw toolError('not-file');
  const renderer = workspaceFileRenderer(target.rel);
  if (target.info.size > MAX_TOOL_FILE_BYTES) {
    return { kind: 'large', renderer, path: target.rel, name: basename(target.rel), size: target.info.size };
  }
  const ext = extname(target.rel).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return { kind: 'image', renderer: 'image', path: target.rel, name: basename(target.rel), size: target.info.size };
  }
  if (ext === '.pdf') {
    return { kind: 'pdf', renderer: 'pdf', path: target.rel, name: basename(target.rel), size: target.info.size };
  }
  const buf = await readFile(target.abs);
  if (!TEXT_EXTS.has(ext) && appearsBinary(buf)) {
    return { kind: 'binary', renderer: 'download', path: target.rel, name: basename(target.rel), size: target.info.size };
  }
  return {
    kind: 'text',
    renderer,
    path: target.rel,
    name: basename(target.rel),
    size: target.info.size,
    content: buf.toString('utf8'),
    version: fileVersion(buf),
  };
}

/**
 * Markdown 파일을 낙관적 잠금으로 저장한다.
 * 열린 시점의 version과 디스크의 최신 version이 다르면 외부 변경을 덮지 않고 409를 반환한다.
 * 같은 프로세스 안의 동시 저장은 경로별로 직렬화하고, 실제 교체는 임시 파일 + rename으로 원자화한다.
 */
export async function saveWorkspaceToolMarkdown(wsId, rootId, input, content, expectedVersion) {
  const rel = normalizeToolRelative(input);
  if (extname(rel).toLowerCase() !== '.md') throw toolError('markdown-only', 415);
  if (typeof content !== 'string') throw toolError('invalid-content');
  if (Buffer.byteLength(content, 'utf8') > MAX_TOOL_FILE_BYTES) throw toolError('too-large', 413);
  if (!/^[a-f0-9]{64}$/.test(String(expectedVersion || ''))) throw toolError('invalid-version');

  return withLock(`workspace-tool-write:${wsId}:${rootId}:${rel}`, async () => {
    // 락 안에서 경로와 내용을 다시 읽는다. 저장 대기 중 파일이나 등록 루트가 바뀌어도 예전 판정을 재사용하지 않는다.
    const target = await resolveWorkspaceToolPath(wsId, rootId, rel);
    if (!target.info.isFile()) throw toolError('not-file');
    const current = await readFile(target.abs);
    if (fileVersion(current) !== expectedVersion) throw toolError('file-changed', 409);

    const body = Buffer.from(content, 'utf8');
    await writeFileAtomic(target.abs, body, { mode: target.info.mode & 0o777 });
    return {
      kind: 'text',
      renderer: 'markdown',
      path: target.rel,
      name: basename(target.rel),
      size: body.length,
      content,
      version: fileVersion(body),
    };
  });
}

export async function readWorkspaceToolRaw(wsId, rootId, input) {
  const target = await resolveWorkspaceToolPath(wsId, rootId, input);
  if (!target.info.isFile()) throw toolError('not-file');
  if (target.info.size > MAX_TOOL_RAW_BYTES) throw toolError('too-large', 413);
  const ext = extname(target.rel).toLowerCase();
  return {
    body: await readFile(target.abs),
    name: basename(target.rel),
    type: MIME[ext] || 'application/octet-stream',
    inline: IMAGE_EXTS.has(ext) || ext === '.pdf',
  };
}

/** 파일 필터는 서버 루트 안을 제한적으로 순회한다. node_modules 같은 대형 트리에서도 상한 뒤 즉시 멈춘다. */
export async function searchWorkspaceToolFiles(wsId, rootId, input) {
  const query = String(input ?? '').trim().toLocaleLowerCase();
  if (!query) return { root: publicRoot(await resolveWorkspaceToolRoot(wsId, rootId)), query: '', entries: [] };
  const root = await resolveWorkspaceToolRoot(wsId, rootId);
  const queue = [''];
  const entries = [];
  let visits = 0;

  while (queue.length && entries.length < MAX_TOOL_SEARCH_RESULTS && visits < MAX_TOOL_SEARCH_VISITS) {
    const parentRel = queue.shift();
    const abs = parentRel ? join(root.root, ...parentRel.split('/')) : root.root;
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      visits += 1;
      if (visits > MAX_TOOL_SEARCH_VISITS) break;
      const entry = await safeEntry(root, parentRel, dirent);
      if (!entry) continue;
      if (entry.name.toLocaleLowerCase().includes(query) || entry.path.toLocaleLowerCase().includes(query)) {
        entries.push(entry);
        if (entries.length >= MAX_TOOL_SEARCH_RESULTS) break;
      }
      // 심링크 디렉터리는 루트 안을 가리키더라도 검색 큐에는 넣지 않는다. 순환 링크로 같은
      // 트리를 되풀이하는 일을 막고, 트리에서 명시적으로 펼칠 때만 1회 접근하게 한다.
      if (entry.type === 'directory' && !entry.symlink) queue.push(entry.path);
    }
  }
  return {
    root: publicRoot(root),
    query,
    entries,
    limited: visits >= MAX_TOOL_SEARCH_VISITS || entries.length >= MAX_TOOL_SEARCH_RESULTS,
  };
}

export const publicRoot = ({ id, kind, label, location }) => ({ id, kind, label, location });

/** 테스트·진단용: 두 경로가 같은 루트 경계에 있는지 OS 구분자 기준으로 판정한다. */
export function relativeInside(target, root) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}
