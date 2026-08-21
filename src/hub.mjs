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
      // 기억 칩 = 기억 화면 트리 칩과 같은 셈법(docs+projects 합) — 두 화면 숫자 불일치 방지(PR #204 LOW).
      // 수는 경량 카운트로: listProjectDocs는 전 파일 stat + md 본문 readFile이라, listCompanies를
      // 타는 gateway 10초 폴에 산출물 수천 개면 수백 ms가 실린다(분리 검수 2026-07-31 M-1 실측).
      // 산출물 카운트 실패가 회사 카드까지 무너뜨리지 않게 격벽(vault route의 M-2와 동일).
      const projectCount = await countProjectFiles(e.name).catch(() => 0);
      out.push({ ...company, crew: agents.length, memories: docs.length + projectCount });
    } catch { /* company.json 없는 폴더는 워크스페이스가 아님 */ }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** 산출물 파일 수만 — 회사 카드 기억 칩 전용 경량 walk(readdir만, readFile·stat 없음).
    포함/제외 규칙은 listProjectDocs와 동일해야 두 화면 숫자가 같다: 닷파일 제외 ·
    심링크 제외 · 디렉터리 재귀 · 나머지 전부 카운트(md/비md 구분 없음).
    (listProjectDocs의 stat 실패 제외는 여기 없다 — 삭제 경합 순간의 ±1은 카운트에 무해) */
export async function countProjectFiles(wsId) {
  const p = paths(wsId);
  let n = 0;
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
      n += 1;
    }
  }
  await walk(p.projects);
  return n;
}

/** 회사 id 목록만 — 디렉터리 열거 + company.json 존재 확인으로 끝낸다(내용 파싱 없음).
    listCompanies()는 회사마다 전 크루 md·전 vault md 본문을 읽어, id만 필요한 스케줄러
    60초 폴에 태우기엔 비싸다(분리 검수 2026-07-28 LOW-1). id = 폴더명(workspace.mjs가
    company.json의 id를 wsId로 강제하므로 동치). */
export async function listCompanyIds() {
  let entries = [];
  try { entries = await readdir(WS_ROOT, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      // wsId 규칙 검증 — listCompanies는 listAgents→paths 경유로 암묵 필터했다. 이게 빠지면
      // Finder 복제본("co copy") 같은 규칙 위반 폴더가 하류 paths() throw로 틱 전체를 죽인다(검수 HIGH-1)
      paths(e.name);
      await stat(join(WS_ROOT, e.name, 'company.json')); // company.json 없는 폴더는 워크스페이스가 아님
      out.push(e.name);
    } catch { /* skip */ }
  }
  return out;
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
      effort: meta.effort || '', // 크루별 추론 강도('' = 모델 기본) — 카드 셀렉터의 원천

      expertise: sectionBullets(md, '전문성'),
      tone: sectionBullets(md, '톤', 1)[0] || '',
    });
  }
  return out;
}

/** vault 문서 목록 — 최신순. 제목/링크/발췌까지 화면용으로 가공. */
export async function listDocs(wsId) {
  const p = paths(wsId);
  const dirName = new Map([[p.journal, 'journal'], [p.conversations, 'conversations'], [p.notes, 'notes']]);
  // 파일 목록부터 모은 뒤 읽기는 묶음 병렬로 — 한 파일씩 await하면 2,000건에 0.6초(실측 Lean-AX),
  // 데크 카드가 그만큼 비어 있다. 묶음 크기는 fd 한도 안에서 넉넉히(ponytail: 64, 필요하면 조정).
  const files = [];
  for (const dir of [p.journal, p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.md')) files.push({ dir, n, file: join(dir, n) });
  }
  const readOne = async ({ dir, n, file }) => {
    const [text, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
    const rel = relSlash(p.vault, file);
    return {
      rel,
      dir: dirName.get(dir),
      title: body.match(/^#\s*(.+)$/m)?.[1] ?? n.replace(/\.md$/, ''),
      links: [...new Set([...text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]))],
      excerpt: body.replace(/^#.*$/gm, '').replace(/\[\[|\]\]/g, '').trim().slice(0, 140),
      mtime: st.mtimeMs,
      // 정렬·표시용 유효 시각 — 파일명에 풀 타임스탬프(대화)가 있으면 그것, 없으면(일지·노트) 수정시각.
      // 예전엔 rel 문자열순 정렬이라 notes/>journal/>conversations/ 접두사 탓에 방금 한 대화가 안 떴다.
      ts: (() => {
        const m = rel.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : st.mtimeMs;
      })(),
    };
  };
  const docs = [];
  for (let i = 0; i < files.length; i += 64) docs.push(...await Promise.all(files.slice(i, i + 64).map(readOne)));
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
