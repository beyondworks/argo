// 회사의 뇌(vault) — 기둥 4. 핸드오버 축적 + 유사 문서 자동 [[링크]] + 인덱스 갱신.
// 스파이크: TF-IDF 코사인 유사도(무의존). 프로덕션: pgvector 임베딩으로 교체(인터페이스 동일).
import { readFile, writeFile, readdir } from 'node:fs/promises';
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
  for (const dir of [p.conversations, p.notes]) {
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

/** 새 문서와 기존 vault 문서를 비교해 상위 유사 문서에 양방향 [[링크]] 삽입. */
export async function autoLink(wsId, newFile, { topK = 3, threshold = 0.12 } = {}) {
  const p = paths(wsId);
  const docs = await vaultDocs(wsId);
  const target = docs.find((d) => d.file === newFile);
  if (!target) return [];
  const others = docs.filter((d) => d.file !== newFile);
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
  await writeFile(file, `${text.trimEnd()}\n- [[${name}]]\n`);
}

/** 턴 핸드오버 저장 — 파일명은 시각+슬러그, 제목은 표시 이름(label). */
export async function saveHandover(wsId, agentSlug, userMsg, reply, label = agentSlug) {
  const p = paths(wsId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = join(p.conversations, `${ts}-${agentSlug}.md`);
  const body = `# ${label} 턴 기록 (${ts})

## 지시
${userMsg}

## 핵심 결과
${reply.slice(0, 1500)}
`;
  await writeFile(file, body);
  const linked = await autoLink(wsId, file);
  return { file, linked };
}

/** vault/_index.md 재생성 — 에이전트의 기억 탐색 진입점. */
export async function updateIndex(wsId) {
  const p = paths(wsId);
  const docs = await vaultDocs(wsId);
  docs.sort((a, b) => b.file.localeCompare(a.file));
  const lines = docs.map((d) => {
    const title = d.text.match(/^#\s*(.+)$/m)?.[1] ?? basename(d.file, '.md');
    const links = [...d.text.matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]);
    return `- [[${d.rel.replace(/\.md$/, '')}]] — ${title}${links.length ? ` (관련: ${links.join(', ')})` : ''}`;
  });
  await writeFile(p.index, `# 회사 기억 인덱스\n\n최근순. [[링크]]를 따라 관련 맥락으로 이동.\n\n${lines.join('\n')}\n`);
}
