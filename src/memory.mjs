// 회사의 뇌(vault) — 기둥 4. 3층 구조: 일지(journal, 턴 원본 append) → 주제 노트(notes, 정제된 단일 진실)
// → 정리 데몬(consolidate)이 매일 일지를 주제 노트로 통합한다. 자동 [[링크]] + 인덱스 갱신.
// 스파이크: TF-IDF 코사인 유사도(무의존). 프로덕션: pgvector 임베딩으로 교체(인터페이스 동일).
import { readFile, readdir, appendFile, mkdir, stat, utimes } from 'node:fs/promises';
import { writeJsonAtomic } from './jsonstore.mjs';
import { existsSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { paths } from './workspace.mjs';
import { GUIDE_NOTE } from './provision.mjs'; // 스캐폴드 안내 노트 — 자동 링크 후보에서 뺀다
import { docMeta, localDay, noteDate } from './vaultdoc.mjs';
import { loadDocsMeta, invalidatePath } from './memindex.mjs';

export { localDay, noteDate }; // 기존 호출·회귀 테스트 호환(판정 정본은 vaultdoc.mjs 한 곳)
export { vaultDocs as vaultDocsForTest }; // 회귀 테스트용(조직 문서 미러 org/ 색인 범위 — G-2)

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

const warnedVaultReadFail = new Set(); // 같은 파일 경고 반복 방지(memindex.mjs와 동일 정책)

async function vaultDocs(wsId) {
  const p = paths(wsId);
  const docs = [];
  for (const dir of [p.journal, p.conversations, p.notes, p.org]) { // org/ = 조직 문서 미러(G-2) — 하위 폴더까지
    let names = [];
    try { names = (await readdir(dir, dir === p.org ? { recursive: true } : undefined)).map((n) => String(n).split('\\').join('/')); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const file = join(dir, n);
      // rel은 논리 경로('/' 고정) — Windows relative()의 백슬래시가 notes/·journal/ 필터를 깨지 않게
      // mtime은 캐시 경로와 같은 정밀도로 맞춘다 — 안 맞추면 동일자 타이브레이크가 두 경로에서 갈린다
      const mtimeMs = Math.round((await stat(file).catch(() => null))?.mtimeMs ?? 0);
      // 읽기 실패를 throw로 터뜨리지 않는다: 이 경로는 캐시 장애 시의 안전망이라 캐시보다 약하면 안 된다
      // (디렉터리인데 .md로 끝남·깨진 심링크·권한 없음에서 saveHandover 전체가 죽었다 — 검수 MEDIUM)
      const text = await readFile(file, 'utf8').catch(() => null);
      if (text === null) {
        if (!warnedVaultReadFail.has(file)) { // 파일당 1회 — 영구 불가 파일이 턴마다 로그를 쌓지 않게
          warnedVaultReadFail.add(file);
          console.warn(`[memory] 문서를 읽지 못해 인덱스에서 뺍니다(회복 시 자동 복귀): ${file}`);
        }
        continue;
      }
      warnedVaultReadFail.delete(file);
      docs.push({ file, rel: relative(p.vault, file).split(sep).join('/'), text, mtimeMs });
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
  // 안내 노트는 폴더 어휘를 다 담고 있어 자동 링크의 자석이 된다(검수 실측: 노트 1건 회사가 안내 노트와 엮여 연결 100%) — 후보에서 뺀다
  const others = docs.filter((d) => d.file !== newFile && d.rel.startsWith('notes/') && d.rel !== `notes/${GUIDE_NOTE}`);
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

/** 문서에서 링크 섹션들을 분리 — { body, links: { 근거: [], 관련: [] } }. 중복 섹션도 전부 회수.
    링크 전용(모든 줄이 "- [[..]]" 불릿) 또는 빈 섹션만 흡수한다 — 산문이 섞인 섹션은 통째로 body에
    남긴다(검수 MEDIUM 2026-07-19: 섹션 안 산문을 침묵 유실하면 "기억 유실 금지" 원칙 위반.
    남은 섹션의 링크는 include 중복 검사가 재추가를 막아 이중화되지 않는다). */
export function splitLinkSections(text) {
  const links = { 근거: [], 관련: [] };
  const re = /\n## (근거|관련)\n([\s\S]*?)(?=\n## |$)/g;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    const [whole, name, content] = m;
    const lines = content.split('\n').filter((l) => l.trim());
    const absorbable = lines.every((l) => /^\s*[-*]\s*\[\[.+?\]\]\s*$/.test(l)); // 빈 섹션([])도 true — 잃을 게 없다
    if (!absorbable) continue; // 산문 섞임 — body에 그대로 남긴다
    for (const l of content.matchAll(/\[\[(.+?)\]\]/g)) links[name].push(l[1]);
    out += text.slice(last, m.index) + '\n';
    last = m.index + whole.length;
  }
  out += text.slice(last);
  return { body: out.replace(/\n{3,}/g, '\n\n'), links };
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

/** 링크만 덧붙이는 쓰기 — 파일의 원래 mtime을 복원한다. 역링크는 그 문서의 내용이 갱신된 게 아니라
    이웃이 생긴 것뿐이라, mtime을 올리면 "언제 갱신됐나"가 거짓이 된다. frontmatter가 없는 노트(크루가
    Write로 직접 쓴 것)는 mtime이 유일한 시간 근거라, 이 오염이 곧 인덱스 순서 오염이었다(검수 HIGH). */
async function writeKeepingMtime(file, content) {
  const before = (await stat(file).catch(() => null))?.mtime ?? null;
  await writeJsonAtomic(file, content);
  if (before) await utimes(file, before, before).catch(() => {}); // 복원 실패는 치명적이지 않다
  // mtime을 되돌렸으니 캐시의 변경 판정(mtime+size)이 이 변경을 못 볼 수 있다 — 명시적으로 무효화한다.
  // 링크 섹션은 append가 아니라 재조립이라 중복 제거·공백 정규화로 크기가 줄 수도 있고, 늘어난 만큼과
  // 상쇄되면 mtime·size가 모두 같아진다(검수 HIGH — 실제로 재현됨).
  await invalidatePath(file);
}

async function appendLink(file, relPath) {
  const name = relPath.replace(/\.md$/, '');
  const text = await readFile(file, 'utf8');
  if (text.includes(`[[${name}]]`)) return; // 중복 링크 방지(본문 언급 포함)
  const { body, links } = splitLinkSections(text);
  links.관련.push(name);
  await writeKeepingMtime(file, `${body.trimEnd()}\n${renderLinkSections(links)}`);
}

/** 근거 링크 추가(정리 데몬용) — 결론이 어느 일지에서 왔는지 역추적. 섹션 파서 경유라 관련과 안 섞인다. */
export async function appendSourceLinks(file, rels) {
  const text = await readFile(file, 'utf8');
  const fresh = rels.filter((r) => !text.includes(`[[${r}]]`));
  if (!fresh.length) return;
  const { body, links } = splitLinkSections(text);
  links.근거.push(...fresh);
  await writeKeepingMtime(file, `${body.trimEnd()}\n${renderLinkSections(links)}`);
}

/** 턴 핸드오버 — 크루별 하루 1파일 일지에 append(원수 층). 링크·정제는 정리 데몬이 맡는다. */
export async function saveHandover(wsId, agentSlug, userMsg, reply, label = agentSlug, { tag = '' } = {}) {
  const p = paths(wsId);
  const now = new Date();
  // 일지 날짜·시각은 사용자 로컬 기준 — UTC 혼용 시 저녁 턴이 어제 일지에 적힌다
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hm = now.toTimeString().slice(0, 5);
  // tag(예: org-<orgId>) = 팀 메신저 조직 채널 턴 — 같은 날 일지라도 **별도 파일**로 둔다. 하루 파일은 절(section)을
  // 덧붙이는 구조라 절 단위 삭제가 불가능한데, 오프보딩 "조직 데이터 회수"는 파일 단위로 지워야 하기 때문(MESSENGER-DESIGN.md).
  const safeTag = String(tag).replace(/[^a-z0-9-]/gi, '').slice(0, 60);
  const file = join(p.journal, `${day}-${agentSlug}${safeTag ? `.${safeTag}` : ''}.md`);
  await mkdir(p.journal, { recursive: true });
  const gist = userMsg.replace(/\s+/g, ' ').trim().slice(0, 48);
  const head = existsSync(file) ? '' : `# ${day} ${label} 일지${safeTag ? ` (${safeTag})` : ''}\n`;
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
  await writeJsonAtomic(file, `---\nupdated: ${localDay()}\n---\n# ${title.trim()}\n\n${cur.body.trim()}\n${renderLinkSections(links)}`);
  const linked = await autoLink(wsId, file);
  return { file, linked };
}

/** 캐시를 못 쓸 때의 정본 경로 — vault 전체를 읽어 메타를 만든다. 캐시 경로(loadDocsMeta)와 반환
    형태가 같아야 한다. 문서 수에 비례해 느리므로 폴백 전용이다. */
async function vaultDocsMeta(wsId) {
  return (await vaultDocs(wsId)).map((d) => docMeta(d.rel, d.text, d.mtimeMs));
}

/* 인덱스에 싣는 주제 노트 수 상한. 인덱스는 크루가 기억을 여는 첫 화면이고 컨텍스트에 통째로 들어간다 —
   노트가 수만 개면 수만 줄짜리 목록이 되어 읽히지도, 컨텍스트에 담기지도 않는다(2026-07-26 유건 결정).
   잘린 나머지는 사라지는 게 아니라 Grep으로 찾는다. 그래서 잘렸다는 사실과 찾는 법을 함께 적는다. */
const NOTE_LIMIT = 200;
const CONFLICT_LIMIT = 20;

/** vault/_index.md 재생성 — 주제 노트(정제수) 우선, 최근 일지는 14일치만. 크루의 기억 탐색 진입점. */
export async function updateIndex(wsId) {
  const p = paths(wsId);
  // 캐시(sqlite) 우선 — 못 쓰면 정본 전수 읽기로 폴백한다. 산출물은 두 경로가 동일해야 한다.
  const docs = (await loadDocsMeta(wsId)) ?? (await vaultDocsMeta(wsId));
  // rel 역순 = 기존 파일명 역순과 같다(구간별로 같은 폴더라 경로 접두가 동일) — 일지의 최신순이 유지된다.
  docs.sort((a, b) => b.rel.localeCompare(a.rel));
  const line = (d, stamp = null) => {
    const when = stamp?.date ? ` (갱신 ${stamp.date}${stamp.exact ? '' : ' 추정'})` : '';
    return `- [[${d.rel.replace(/\.md$/, '')}]] — ${d.title}${when}${d.links.length ? ` (관련: ${d.links.join(', ')})` : ''}`;
  };
  // 주제 노트는 갱신일 내림차순 — 파일명(주제 슬러그) 정렬은 시간 정보가 0이라 옛 절차와 최신 절차가
  // 순서 없이 섞여 나온다. 일지는 파일명이 YYYY-MM-DD로 시작해 날짜 순서는 파일명이 맞고, 같은 날 안은 아래에서 mtime으로 푼다.
  // 동일자 타이브레이크는 mtime — 파일명으로 깨면 saveNote(create)의 접미 번호(-2,-3) 계열에서
  // 항상 v1이 최상단으로 올라와 고치려던 문제가 그대로 남는다(검수 MEDIUM).
  // 동기화 충돌 사본(sync.mjs가 `<슬러그>.conflict-<기기>-<ts>.md`로 보존하는 패배한 로컬본)은 주제 노트에서
  // 뺀다 — 내용은 옛것인데 파일 기록 시각이 '지금'이라(writeLocal에 mtime 미전달) 최신인 척 최상단을 차지한다.
  // 지우지는 않는다: 기억 유실 금지 — 아래 별도 섹션에 그대로 남겨 사장이 병합·정리할 수 있게 한다.
  const allNotes = docs.filter((d) => d.kind === 'note')
    .map((d) => ({ d, stamp: d.stamp }))
    .sort((a, b) => b.stamp.date.localeCompare(a.stamp.date) || (b.d.mtimeMs - a.d.mtimeMs) || b.d.rel.localeCompare(a.d.rel));
  const notes = allNotes.slice(0, NOTE_LIMIT);
  // 충돌 사본도 최신순으로 자른다 — rel 순서 그대로 자르면 가장 최근 충돌이 잘려 나가는데,
  // 이 섹션의 지시("확인 후 병합하고 지워라")가 정확히 최근 충돌부터 보라는 뜻이다(검수 MEDIUM).
  const allConflicts = docs.filter((d) => d.kind === 'conflict')
    .sort((a, b) => (b.mtimeMs - a.mtimeMs) || b.rel.localeCompare(a.rel));
  const conflicts = allConflicts.slice(0, CONFLICT_LIMIT);
  const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  // 일별(YYYY-MM-DD-*)과 주간 롤업(YYYY-Wnn)을 분리 — 'W' > 숫자라 문자열 비교 컷오프를 주간 파일이
  // 항상 통과해 "최근 일지"에 영구 누적되고, 미정리 14일+ 일지는 실종되던 문제의 교정(분류는 vaultdoc.docKind).
  // 같은 날 안의 순서는 파일명이 아니라 기록 시각(mtime)이다 — 회의록은 같은 분에 두 번 마치면 `-2` 접미가 붙는데
  // (room.mjs endMeetingLocked), 파일명 역순은 base → -3 → -2로 최신순이 깨진다(주제 노트가 같은 이유로 mtime
  // 타이브레이크를 쓴다 — 위 주석). 날짜(파일명 앞 10자)가 먼저, 그다음 mtime, 마지막 파일명.
  const dayOf = (d) => basename(d.rel).slice(0, 10);
  const journals = docs.filter((d) => d.kind === 'journal' && basename(d.rel) >= cutoff)
    .sort((a, b) => dayOf(b).localeCompare(dayOf(a)) || (b.mtimeMs - a.mtimeMs) || b.rel.localeCompare(a.rel));
  const weeklies = docs.filter((d) => d.kind === 'weekly').slice(0, 8);
  const legacy = docs.filter((d) => d.kind === 'legacy').slice(0, 10);
  const orgDocs = docs.filter((d) => d.kind === 'org').sort((a, b) => a.rel.localeCompare(b.rel)); // 팀 메신저 조직 문서 미러(G-2) — 정본은 서버, 여기서는 읽기만
  await writeJsonAtomic(p.index, `# 회사 기억 인덱스

주제 노트가 정리된 지식이다 — 먼저 여기서 찾고, 상세 근거가 필요할 때만 일지를 열어라.

## 주제 노트 (갱신일 최신순 — 같은 주제가 여러 벌이면 위쪽이 더 최근이다. "추정"은 파일 기록 시각 기준)
${notes.map(({ d, stamp }) => line(d, stamp)).join('\n') || '(아직 없음)'}${allNotes.length > notes.length
  ? `\n\n(최근 ${notes.length}개만 실었다. 나머지 ${allNotes.length - notes.length}개도 그대로 남아 있으니, 여기 없는 주제는 vault/notes/ 를 Grep으로 찾아라 — 없다고 단정하지 마라.)`
  : ''}

## 최근 일지 (턴 원본, 14일)
${journals.map((d) => line(d)).join('\n') || '(아직 없음)'}
${orgDocs.length ? `\n## 조직 문서 (팀 메신저 조직의 규칙집·용어집·프로젝트 맥락 — 서버 정본의 읽기 전용 미러. 전사 규칙은 개인 규칙보다 우선한다)\n${orgDocs.map((d) => line(d)).join('\n')}\n` : ''}${weeklies.length ? `\n## 주간 일지 (7일 지난 기억의 요약, 최근 8주)\n${weeklies.map((d) => line(d)).join('\n')}\n` : ''}${legacy.length ? `\n## 이전 기록\n${legacy.map((d) => line(d)).join('\n')}\n` : ''}${conflicts.length ? `\n## 동기화 충돌 사본 (다른 기기와 같은 노트를 동시에 고쳐 갈라진 것 — 내용은 옛 판일 수 있다. 확인 후 병합하고 지워라)\n${conflicts.map((d) => line(d)).join('\n')}${allConflicts.length > conflicts.length ? `\n(외 ${allConflicts.length - conflicts.length}개 더 — vault/notes/ 의 .conflict- 파일을 확인하라)` : ''}\n` : ''}`);
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
