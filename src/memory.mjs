// 회사의 뇌(vault) — 기둥 4. 3층 구조: 일지(journal, 턴 원본 append) → 주제 노트(notes, 정제된 단일 진실)
// → 정리 데몬(consolidate)이 매일 일지를 주제 노트로 통합한다. 자동 [[링크]] + 인덱스 갱신.
// 스파이크: TF-IDF 코사인 유사도(무의존). 프로덕션: pgvector 임베딩으로 교체(인터페이스 동일).
import { readFile, readdir, appendFile, mkdir } from 'node:fs/promises';
import { writeJsonAtomic } from './jsonstore.mjs';
import { existsSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
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
      // rel은 논리 경로('/' 고정) — Windows relative()의 백슬래시가 notes/·journal/ 필터를 깨지 않게
      docs.push({ file, rel: relative(p.vault, file).split(sep).join('/'), text: await readFile(file, 'utf8') });
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

/* ── 링크 섹션(## 근거 · ## 관련) — 위치 가정 없는 파서.
   과거엔 "관련은 항상 마지막" 규약에 기대 파일 끝 append를 썼는데, 근거(정리 데몬)도 끝에 붙으면서
   규약이 깨져 관련 링크가 근거 섹션 안에 들어가고(오표기), merge가 근거 섹션을 통째로 유실했다.
   이제 섹션이 어디에 몇 번 있든 전부 뽑아 정규 순서(본문 → ## 근거 → ## 관련)로 재조립한다. */
const LINK_SECTIONS = ['근거', '관련'];

/** 문서에서 링크 섹션들을 분리 — { body, links: { 근거: [], 관련: [] } }. 중복 섹션도 전부 회수. */
export function splitLinkSections(text) {
  const links = { 근거: [], 관련: [] };
  let body = text;
  for (const name of LINK_SECTIONS) {
    const re = new RegExp(`\\n## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`);
    let m;
    while ((m = body.match(re))) {
      for (const l of m[1].matchAll(/\[\[(.+?)\]\]/g)) links[name].push(l[1]);
      body = body.replace(re, '\n');
    }
  }
  return { body: body.replace(/\n{3,}/g, '\n\n'), links };
}

/** 링크 섹션 재조립 — 정규 순서·중복 제거. 빈 섹션은 만들지 않는다. */
export function renderLinkSections(links) {
  let out = '';
  for (const name of LINK_SECTIONS) {
    const uniq = [...new Set(links[name] ?? [])];
    if (uniq.length) out += `\n## ${name}\n${uniq.map((l) => `- [[${l}]]`).join('\n')}\n`;
  }
  return out;
}

async function appendLink(file, relPath) {
  const name = relPath.replace(/\.md$/, '');
  const text = await readFile(file, 'utf8');
  if (text.includes(`[[${name}]]`)) return; // 중복 링크 방지(본문 언급 포함)
  const { body, links } = splitLinkSections(text);
  links.관련.push(name);
  await writeJsonAtomic(file, `${body.trimEnd()}\n${renderLinkSections(links)}`);
}

/** 근거 링크 추가(정리 데몬용) — 결론이 어느 일지에서 왔는지 역추적. 섹션 파서 경유라 관련과 안 섞인다. */
export async function appendSourceLinks(file, rels) {
  const text = await readFile(file, 'utf8');
  const fresh = rels.filter((r) => !text.includes(`[[${r}]]`));
  if (!fresh.length) return;
  const { body, links } = splitLinkSections(text);
  links.근거.push(...fresh);
  await writeJsonAtomic(file, `${body.trimEnd()}\n${renderLinkSections(links)}`);
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
  // 장문 응답은 절단 표시를 남긴다 — 표시 없이 자르면 크루·정리 데몬이 잘린 걸 완전한 기록으로 오인한다
  const full = reply.trim();
  const body = full.length > 1500 ? `${full.slice(0, 1500).trim()}\n…(길이 초과로 생략 — 전체 ${full.length}자, 원문은 대화 스레드에)` : full;
  const section = `\n## ${hm} — ${gist}

지시: ${userMsg.trim()}

${body}
`;
  await appendFile(file, head + section);
  await updateIndex(wsId);
  return { file, linked: [] };
}

export function noteSlug(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'note';
}

/** 주제 노트 저장 — 주제당 1파일이 단일 진실. 같은 슬러그면 갱신(updated 갱신), 링크는 자동.
    create=true(신규 작성 액션)면 슬러그 충돌 시 기존 노트를 덮지 않고 접미 번호(-2,-3…)로 분리 저장한다
    — 서로 다른 주제가 같은 정규화 슬러그로 수렴해 앞 노트를 조용히 파괴하던 기억 유실 방지. */
export async function saveNote(wsId, title, content, { merge = false, create = false } = {}) {
  const p = paths(wsId);
  await mkdir(p.notes, { recursive: true });
  const base = noteSlug(title);
  let slug = base;
  if (create) { for (let n = 2; existsSync(join(p.notes, `${slug}.md`)); n++) slug = `${base}-${n}`; }
  const file = join(p.notes, `${slug}.md`);
  // merge = 기존 링크 섹션(근거·관련)을 전부 보존하고 본문만 갱신 — 과거엔 '관련이 마지막' 가정의
  // 정규식이라 근거가 뒤에 붙은 파일에서 근거만 남고 관련이 유실되거나 그 반대가 났다(파서로 교체).
  let kept = { 근거: [], 관련: [] };
  if (merge && existsSync(file)) {
    kept = splitLinkSections(await readFile(file, 'utf8')).links;
  }
  const cur = splitLinkSections(content.trim()); // LLM/사용자가 섹션을 본문에 섞어 보내도 회수해 합친다
  const links = { 근거: [...kept.근거, ...cur.links.근거], 관련: [...kept.관련, ...cur.links.관련] };
  await writeJsonAtomic(file, `---\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n# ${title.trim()}\n\n${cur.body.trim()}\n${renderLinkSections(links)}`);
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
  // 일별(YYYY-MM-DD-*)과 주간 롤업(YYYY-Wnn)을 분리 — 'W' > 숫자라 문자열 비교 컷오프를 주간 파일이
  // 항상 통과해 "최근 일지"에 영구 누적되고, 미정리 14일+ 일지는 실종되던 문제의 교정.
  const journals = docs.filter((d) => d.rel.startsWith('journal/') && /^\d{4}-\d{2}-\d{2}-/.test(basename(d.rel)) && basename(d.rel) >= cutoff);
  const weeklies = docs.filter((d) => d.rel.startsWith('journal/') && /^\d{4}-W\d{2}\.md$/.test(basename(d.rel))).slice(0, 8);
  const legacy = docs.filter((d) => d.rel.startsWith('conversations/')).slice(0, 10);
  await writeJsonAtomic(p.index, `# 회사 기억 인덱스

주제 노트가 정리된 지식이다 — 먼저 여기서 찾고, 상세 근거가 필요할 때만 일지를 열어라.

## 주제 노트
${notes.map(line).join('\n') || '(아직 없음)'}

## 최근 일지 (턴 원본, 14일)
${journals.map(line).join('\n') || '(아직 없음)'}
${weeklies.length ? `\n## 주간 일지 (7일 지난 기억의 요약, 최근 8주)\n${weeklies.map(line).join('\n')}\n` : ''}${legacy.length ? `\n## 이전 기록\n${legacy.map(line).join('\n')}\n` : ''}`);
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
