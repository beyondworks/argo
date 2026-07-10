// 웹 UI 전용 읽기 뷰 — 워크스페이스/크루/vault를 화면이 먹기 좋은 형태로 가공한다.
// 쓰기는 전부 기존 코어(workspace/persona/chat/memory)를 그대로 쓴다.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { WS_ROOT, paths } from './workspace.mjs';

function parseFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return meta;
}

/** "## 섹션" 아래 불릿 몇 개를 추린다 — 크루 카드 요약용. */
function sectionBullets(md, heading, max = 3) {
  const m = md.match(new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`));
  if (!m) return [];
  return m[1].split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('('))
    .slice(0, max);
}

export async function listCompanies() {
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const company = JSON.parse(await readFile(join(WS_ROOT, e.name, 'company.json'), 'utf8'));
      const agents = await listAgents(e.name);
      const docs = await listDocs(e.name);
      out.push({ ...company, crew: agents.length, memories: docs.length });
    } catch { /* company.json 없는 폴더는 워크스페이스가 아님 */ }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

export async function listAgents(wsId) {
  const p = paths(wsId);
  let names = [];
  try { names = await readdir(p.agents); } catch { return []; }
  const out = [];
  for (const n of names.filter((f) => f.endsWith('.md')).sort()) {
    const md = await readFile(join(p.agents, n), 'utf8');
    const meta = parseFrontmatter(md);
    out.push({
      slug: n.replace(/\.md$/, ''),
      name: meta.name || n.replace(/\.md$/, ''),
      role: meta.role || '',
      team: meta.team || '',
      model: meta.model || '',
      expertise: sectionBullets(md, '전문성'),
      tone: sectionBullets(md, '톤', 1)[0] || '',
    });
  }
  return out;
}

/** vault 문서 목록 — 최신순. 제목/링크/발췌까지 화면용으로 가공. */
export async function listDocs(wsId) {
  const p = paths(wsId);
  const docs = [];
  for (const dir of [p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const file = join(dir, n);
      const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
      docs.push({
        rel: relative(p.vault, file),
        dir: dir === p.conversations ? 'conversations' : 'notes',
        title: body.match(/^#\s*(.+)$/m)?.[1] ?? n.replace(/\.md$/, ''),
        links: [...new Set([...text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]))],
        excerpt: body.replace(/^#.*$/gm, '').replace(/\[\[|\]\]/g, '').trim().slice(0, 140),
        mtime: st.mtimeMs,
      });
    }
  }
  return docs.sort((a, b) => b.rel.localeCompare(a.rel));
}

/** vault 문서 1건 읽기 — vault 밖 경로 차단. */
export async function readDoc(wsId, rel) {
  const p = paths(wsId);
  const file = resolve(p.vault, rel.endsWith('.md') ? rel : `${rel}.md`);
  if (!file.startsWith(resolve(p.vault) + '/') && file !== resolve(p.index)) {
    throw new Error('vault 밖 경로');
  }
  return readFile(file, 'utf8');
}
