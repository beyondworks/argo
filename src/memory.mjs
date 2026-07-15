// 회사의 뇌(vault) — 기둥 4. 3층 구조: 일지(journal, 턴 원본 append) → 주제 노트(notes, 정제된 단일 진실)
// → 정리 데몬(consolidate)이 매일 일지를 주제 노트로 통합한다. 자동 [[링크]] + 인덱스 갱신.
// 스파이크: TF-IDF 코사인 유사도(무의존). 프로덕션: pgvector 임베딩으로 교체(인터페이스 동일).
import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { writeJsonAtomic } from './jsonstore.mjs';
import { existsSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { paths } from './workspace.mjs';

// ── 토큰화 — 한글(2gram)+영문 단어. 짧은 조사류 노이즈를 줄이는 최소 구현.
function tokens(text) {
  const out = [];
  const cleaned = text.toLowerCase().replace(/\[\[.*?\]\]/g, ' ');
  for (const w of cleaned.match(/[a-z0-9]{2,}/g) ?? []) out.push(w);
  const ko = cleaned.match(/[가-힣]+/g) ?? [];
  for (const run of ko) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

function tf(toks) {
  const m = new Map();
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function cosine(a, b, idf) {
  let dot = 0, na = 0, nb = 0;
  for (const [t, w] of a) {
    const wa = w * (idf.get(t) ?? 1);
    na += wa * wa;
    if (b.has(t)) dot += wa * (b.get(t) * (idf.get(t) ?? 1));
  }
  for (const [t, w] of b) {
    const wb = w * (idf.get(t) ?? 1);
    nb += wb * wb;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

async function vaultDocs(wsId) {
  const p = paths(wsId);
  const docs = [];
  for (const dir of [p.journal, p.conversations, p.notes]) {
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const file = join(dir, n);
      docs.push({ file, rel: relative(p.vault, file), text: await readFile(file, 'utf8') });
    }
  }
  return docs;
}

/** 새 문서와 기존 vault 문서를 비교해 상위 유사 문서에 양방향 [[링크]] 삽입.
 *  링크 대상은 주제 노트로 한정 — 일지에 역링크를 쓰면 일지가 다시 자라 정리 워터마크가 어긋난다. */
export async function autoLink(wsId, newFile, { topK = 3, threshold = 0.12 } = {}) {
  const p = paths(wsId);
  const docs = await vaultDocs(wsId);
  const target = docs.find((d) => d.file === newFile);
  if (!target) return [];
  const others = docs.filter((d) => d.file !== newFile && d.rel.startsWith('notes/'));
  if (!others.length) { await updateIndex(wsId); return []; }

  // idf — 문서 수가 적은 스파이크 규모에선 충분. 프로덕션은 임베딩으로 대체.
  const tfs = new Map(docs.map((d) => [d.file, tf(tokens(d.text))]));
  const df = new Map();
  for (const m of tfs.values()) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + docs.length / n)]));

  const scored = others
    .map((d) => ({ d, score: cosine(tfs.get(newFile), tfs.get(d.file), idf) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const linked = [];
  for (const { d, score } of scored) {
    await appendLink(newFile, d.rel);
    await appendLink(d.file, target.rel); // 양방향 — 과거 문서에서도 새 문서로 갈 수 있게
    linked.push({ to: d.rel, score: Number(score.toFixed(3)) });
  }
  await updateIndex(wsId);
  return linked;
}

// "## 관련" 섹션은 항상 문서 마지막에 두는 규약 — 링크는 끝에 append만 하면 된다.
async function appendLink(file, relPath) {
  const name = relPath.replace(/\.md$/, '');
  let text = await readFile(file, 'utf8');
  if (text.includes(`[[${name}]]`)) return; // 중복 링크 방지
  if (!/\n## 관련\n/.test(text)) text = `${text.trimEnd()}\n\n## 관련\n`;
  await writeJsonAtomic(file, `${text.trimEnd()}\n- [[${name}]]\n`);
}

/** 턴 핸드오버 — 크루별 하루 1파일 일지에 append(원수 층). 링크·정제는 정리 데몬이 맡는다. */
export async function saveHandover(wsId, agentSlug, userMsg, reply, label = agentSlug) {
  const p = paths(wsId);
  const now = new Date();
  // 일지 날짜·시각은 사용자 로컬 기준 — UTC 혼용 시 저녁 턴이 어제 일지에 적힌다
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hm = now.toTimeString().slice(0, 5);
  const file = join(p.journal, `${day}-${agentSlug}.md`);
  await mkdir(p.journal, { recursive: true });
  const gist = userMsg.replace(/\s+/g, ' ').trim().slice(0, 48);
  const head = existsSync(file) ? '' : `# ${day} ${label} 일지\n`;
  const section = `\n## ${hm} — ${gist}

지시: ${userMsg.trim()}

${reply.slice(0, 1500).trim()}
`;
  await appendFile(file, head + section);
  await updateIndex(wsId);
  return { file, linked: [] };
}

export function noteSlug(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note';
}

/** 주제 노트 저장 — 주제당 1파일이 단일 진실. 같은 슬러그면 갱신(updated 갱신), 링크는 자동. */
export async function saveNote(wsId, title, content, { merge = false } = {}) {
  const p = paths(wsId);
  await mkdir(p.notes, { recursive: true });
  const file = join(p.notes, `${noteSlug(title)}.md`);
  let related = '';
  if (merge && existsSync(file)) {
    // 기존 '## 관련' 링크는 보존한다 — 정제 내용만 교체
    related = (await readFile(file, 'utf8')).match(/\n## 관련\n[\s\S]*$/)?.[0] ?? '';
  }
  await writeJsonAtomic(file, `---\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n# ${title.trim()}\n\n${content.trim()}\n${related}`);
  const linked = await autoLink(wsId, file);
  return { file, linked };
}

/** vault/_index.md 재생성 — 주제 노트(정제수) 우선, 최근 일지는 14일치만. 크루의 기억 탐색 진입점. */
export async function updateIndex(wsId) {
  const p = paths(wsId);
  const docs = await vaultDocs(wsId);
  docs.sort((a, b) => b.file.localeCompare(a.file));
  const line = (d) => {
    const title = d.text.match(/^#\s*(.+)$/m)?.[1] ?? basename(d.file, '.md');
    const links = [...d.text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]);
    return `- [[${d.rel.replace(/\.md$/, '')}]] — ${title}${links.length ? ` (관련: ${links.join(', ')})` : ''}`;
  };
  const notes = docs.filter((d) => d.rel.startsWith('notes/'));
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const journals = docs.filter((d) => d.rel.startsWith('journal/') && basename(d.rel) >= cutoff);
  const legacy = docs.filter((d) => d.rel.startsWith('conversations/')).slice(0, 10);
  await writeJsonAtomic(p.index, `# 회사 기억 인덱스

주제 노트가 정리된 지식이다 — 먼저 여기서 찾고, 상세 근거가 필요할 때만 일지를 열어라.

## 주제 노트
${notes.map(line).join('\n') || '(아직 없음)'}

## 최근 일지 (턴 원본, 14일)
${journals.map(line).join('\n') || '(아직 없음)'}
${legacy.length ? `\n## 이전 기록\n${legacy.map(line).join('\n')}\n` : ''}`);
}

/* ── 사장 프로필 — "회사가 아는 사장". 크루가 자동 기록·갱신하고, 사장이 크루 카드에서 정정한다. */
export const BOSS_PROFILE_REL = 'notes/사장-프로필.md';
export const BOSS_SECTIONS = ['취향', '결정', '금지'];

export async function readBossProfile(wsId) {
  let md = '';
  try { md = await readFile(join(paths(wsId).vault, BOSS_PROFILE_REL), 'utf8'); } catch { /* 아직 없음 */ }
  const items = [];
  for (const section of BOSS_SECTIONS) {
    const m = md.match(new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`));
    if (!m) continue;
    for (const l of m[1].split('\n')) {
      const text = l.replace(/^[-*]\s*/, '').trim();
      if (text && !text.startsWith('(')) items.push({ section, text });
    }
  }
  return { md, items };
}

/** 항목 배열로 정규 md를 재구성해 저장 — 카드의 정정("그거 잊어")이 곧 파일 수정이다. */
export async function writeBossProfile(wsId, items) {
  const p = paths(wsId);
  const sec = (name) => {
    const list = items.filter((i) => i.section === name && i.text?.trim());
    return `## ${name}\n${list.length ? list.map((i) => `- ${i.text.trim()}`).join('\n') : '(아직 없음)'}\n`;
  };
  const md = `# 사장 프로필 — 회사가 아는 사장

(크루가 대화에서 알게 된 사장의 취향·확정 결정·금지사항을 기록한다. 사장이 크루 카드에서 직접 정정할 수 있다.)

${BOSS_SECTIONS.map(sec).join('\n')}`;
  await mkdir(p.notes, { recursive: true });
  await writeJsonAtomic(join(p.vault, BOSS_PROFILE_REL), md);
  return readBossProfile(wsId);
}
