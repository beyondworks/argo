// 웹 UI 전용 읽기 뷰 — 워크스페이스/크루/vault를 화면이 먹기 좋은 형태로 가공한다.
// 쓰기는 전부 기존 코어(workspace/persona/chat/memory)를 그대로 쓴다.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

// Windows relative()는 백슬래시 — rel은 논리 경로('/' 고정)로 통일해야 notes/·journal/ 필터가 산다
const relSlash = (from, to) => relative(from, to).split(sep).join('/');
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
      runner: meta.runner || '',
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
  const dirName = new Map([[p.journal, 'journal'], [p.conversations, 'conversations'], [p.notes, 'notes']]);
  for (const dir of [p.journal, p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const file = join(dir, n);
      const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
      docs.push({
        rel: relSlash(p.vault, file),
        dir: dirName.get(dir),
        title: body.match(/^#\s*(.+)$/m)?.[1] ?? n.replace(/\.md$/, ''),
        links: [...new Set([...text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]))],
        excerpt: body.replace(/^#.*$/gm, '').replace(/\[\[|\]\]/g, '').trim().slice(0, 140),
        mtime: st.mtimeMs,
        // 정렬·표시용 유효 시각 — 파일명에 풀 타임스탬프(대화)가 있으면 그것, 없으면(일지·노트) 수정시각.
        // 예전엔 rel 문자열순 정렬이라 notes/>journal/>conversations/ 접두사 탓에 방금 한 대화가 안 떴다.
        ts: (() => {
          const m = relSlash(p.vault, file).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
          return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : st.mtimeMs;
        })(),
      });
    }
  }
  return docs.sort((a, b) => b.ts - a.ts); // 최근 활동순 — 오늘 갱신된 일지가 최상단
}

/** 프로젝트 산출물 목록 — vault/projects/ 전체를 재귀로 훑는다(md + 비md 모두).
    listDocs(지식 기억: 일지·대화·노트)와 분리 — 산출물은 기억 수·별자리 그래프에 섞지 않는다.
    고객 신고(2026-07-20): 크루가 만든 문서를 앱에서 못 열고 Finder로 긴 경로를 찾아가야 했다 —
    projects/가 어떤 목록에도 안 잡혔던 것이 원인(비재귀 + 허용 목록 누락). */
export async function listProjectDocs(wsId) {
  const p = paths(wsId);
  const out = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .DS_Store 등
      // 심링크는 목록·서빙 모두 제외 — vault 밖을 가리키는 링크가 다운로드로 유출되는 통로가 된다
      // (릴리스 검수 M-3: 데스크톱은 본인 파일이라 경미하지만 호스팅 합류 시 테넌트 경계 구멍).
      if (e.isSymbolicLink()) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) { await walk(f); continue; }
      // stat 무방어면 워크 중 삭제·동기화 이동 한 건에 목록 전체가 죽고, 화면에선 기억까지 사라져
      // 보인다(릴리스 검수 M-2 — 산출물 한 건 때문에 기억 뷰 붕괴 금지)
      let st;
      try { st = await stat(f); } catch { continue; }
      const rel = relSlash(p.vault, f);
      const md = e.name.endsWith('.md');
      let title = e.name;
      if (md) {
        try { title = (await readFile(f, 'utf8')).match(/^#\s*(.+)$/m)?.[1] ?? e.name.replace(/\.md$/, ''); }
        catch { /* 제목은 장식 — 파일명 폴백 */ }
      }
      out.push({
        rel, // vault 기준 — md는 뷰어(?doc=), 비md는 files?rel= 다운로드
        title,
        // 프로젝트 폴더명(projects/ 바로 아래) — 목록 그룹 라벨. 루트 직치 파일은 ''.
        project: rel.split('/').slice(1, -1)[0] ?? '',
        binary: !md,
        size: st.size,
        mtime: st.mtimeMs,
      });
    }
  }
  await walk(p.projects);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** vault 문서 1건 읽기 — vault 밖 경로 차단. 롤업으로 보관된 일지는 .archive/에서 폴백(링크 불사). */
export async function readDoc(wsId, rel) {
  const p = paths(wsId);
  const file = resolve(p.vault, rel.endsWith('.md') ? rel : `${rel}.md`);
  if (!file.startsWith(resolve(p.vault) + sep) && file !== resolve(p.index)) {
    throw new Error('vault 밖 경로');
  }
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    const m = relSlash(p.vault, file).match(/^journal\/(.+\.md)$/);
    if (m) return readFile(join(p.journal, '.archive', m[1]), 'utf8');
    throw e;
  }
}
