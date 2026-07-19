// 기억 정리 데몬 — 사람 뇌의 수면 정리처럼, 일지(원수)를 읽어 주제 노트(정제수)를 생성/갱신한다.
// 하이쿠 1턴/일/회사 — 원본 일지는 삭제하지 않는다(감사 가능). 워터마크로 새 내용만 정리.
// + 주간 롤업: 7일 지난 일지는 주간 요약 1파일로 접히고 원본은 .archive/로 — 기억은 쌓일수록 정제된다.
import { readFile, readdir, stat, rename, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { runOneShot } from './oneshot.mjs'; // 러너 독립 — 어떤 러너든 연결만 되면 기억 정리가 돈다
import { saveNote, updateIndex, splitLinkSections, appendSourceLinks } from './memory.mjs';
import { appendUsage } from './usage.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';

const WATERMARK = (wsId) => join(paths(wsId).vault, '.consolidate.json');
const CAP = 14_000; // 정리 1회당 읽는 일지 총량 — 넘치면 다음 실행이 이어서 정리

const PROMPT = (journals, noteTitles, lang = 'ko', noteCtx = []) => lang === 'en' ? `You are the librarian of the company's memory. Read the journals (raw conversations) below and distill only knowledge worth reusing into topic notes.
Do not call any tools — the text provided below is all the material you have.

Rules:
- Each topic note is the single source of truth for its topic. If a topic matches an existing note title, reuse that exact title to update it (don't spawn new titles).
- Updating a note REPLACES its body entirely — output a complete body that keeps and integrates the still-valid conclusions from the "existing note excerpts" below (omission = memory loss). When new journals contradict an old decision, prefer the new one and keep a one-line trace like "(was: …)".
- Note content should center on conclusions, decisions, numbers, and rules that "the next crew handling this topic can use right away." No conversation quotes or process narration.
- signal gate: keep only content that passes "does this record help future crew work better?" If it doesn't pass, drop it.
- If the journals hold nothing worth distilling, return an empty array.
- Output ONLY JSON (no code fences, no explanation): {"notes":[{"title":"...","content":"markdown body"}]}

Existing topic note titles: ${noteTitles.length ? noteTitles.join(' | ') : '(none)'}

Existing note excerpts (12 most recent — preserve & integrate when updating):
${noteCtx.map((n) => `[${n.title}]\n${n.body}`).join('\n\n') || '(none)'}

--- journals ---
${journals}` : `당신은 회사 기억의 사서다. 아래 일지(대화 원본)를 읽고 재사용 가치가 있는 지식만 주제 노트로 정제하라.
도구를 호출하지 마라 — 아래 제공된 텍스트가 자료의 전부다.

규칙:
- 주제 노트는 주제당 1개가 단일 진실이다. 기존 노트 제목과 같은 주제면 그 제목을 그대로 써서 갱신하라(새 제목 남발 금지).
- 노트 갱신은 본문 전체 교체다 — 아래 "기존 노트 발췌"의 여전히 유효한 결론을 유지·통합한 완전한 본문을 출력하라(누락 = 기억 유실). 새 일지가 이전 결정과 모순되면 새 결정을 우선하고 "(변경 전: …)" 한 줄로 흔적을 남겨라.
- 노트 내용은 "다음에 이 주제를 다룰 크루가 바로 쓸 수 있는" 결론·결정·수치·규칙 중심으로. 대화 인용·과정 서술 금지.
- signal gate: "이 기록이 미래의 크루를 더 잘 일하게 하는가?"를 통과하는 내용만 남겨라. 통과 못 하면 버린다.
- 일지에 정제할 가치가 있는 내용이 없으면 빈 배열을 반환하라.
- 정확히 JSON만 출력(코드펜스·설명 금지): {"notes":[{"title":"...","content":"마크다운 본문"}]}

기존 주제 노트 제목: ${noteTitles.length ? noteTitles.join(' | ') : '(없음)'}

기존 노트 발췌(최근 12개 — 갱신 시 이 내용을 보존·통합하라):
${noteCtx.map((n) => `[${n.title}]\n${n.body}`).join('\n\n') || '(없음)'}

--- 일지 ---
${journals}`;

async function readWatermark(wsId) {
  // 워터마크는 재생성 가능(원본 일지가 진실) — 손상은 관용하고 처음부터 재정리(readJsonLenient).
  const mark = await readJsonLenient(WATERMARK(wsId), { v: 2, offsets: {} });
  // v2 = 바이트 오프셋. 구버전은 stat().size(바이트)를 문자 인덱스로 오용해 한글 일지(자당 3바이트)에서
  // 정리가 새 내용을 영구 건너뛰었다 — 구버전 워터마크는 리셋해 처음부터 재정리한다(원본이 진실이라 안전,
  // 중복 정제는 merge 프롬프트가 흡수).
  return mark.v >= 2 ? mark : { v: 2, offsets: {} };
}

/** 워터마크 이후의 새 일지 내용만 모은다. sources = 이번 정리에 기여한 일지(근거 링크용). */
async function gatherNewJournal(wsId, mark) {
  const dir = paths(wsId).journal;
  let names = [];
  // 일별(YYYY-MM-DD-*)만 — 주간 롤업(YYYY-Wnn.md)은 정리의 산출물이라 다시 섭취하면 자기 요약을 재정리하는 루프가 된다
  try { names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(n)).sort(); } catch { return { text: '', next: mark, sources: [] }; }
  let text = '';
  const sources = [];
  const next = { v: 2, offsets: { ...mark.offsets } };
  for (const n of names) {
    const file = join(dir, n);
    // Buffer로 읽어 바이트 기준으로 자른다 — 워터마크 오프셋 단위는 바이트(append 경계 = 이전 파일 크기라
    // 멀티바이트 절단 없음). stat 대신 buf.length를 쓰면 읽기·크기가 같은 스냅샷이라 레이스도 없다.
    const buf = await readFile(file);
    const size = buf.length;
    const done = mark.offsets[n] ?? 0;
    if (size <= done || text.length > CAP) { next.offsets[n] = Math.min(done, size); continue; }
    const body = buf.subarray(done).toString('utf8');
    text += `\n[${n}]\n${body}`;
    sources.push(`journal/${n.replace(/\.md$/, '')}`);
    next.offsets[n] = size;
  }
  return { text: text.slice(0, CAP + 4000), next, sources };
}

/** 정리 1회 실행 — 반환: 갱신/생성된 노트 목록. 새 내용 없으면 빈 배열. */
export async function consolidateMemory(wsId) {
  const mark = await readWatermark(wsId);
  const { text, next, sources } = await gatherNewJournal(wsId, mark);
  // 소량이면 스킵(워터마크도 안 움직임) — 정제할 만큼 쌓일 때까지 기다린다
  if (text.trim().length < 400) return { notes: [] };

  const p = paths(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({})); // 시스템 언어 — 주제 노트 정제 언어(기존 회사=ko 폴백)
  // 제목 전체 + 최근 12개 노트의 본문 발췌 — 본문 없이 제목만 주면 LLM이 기존 결론을 모른 채 본문을
  // 새로 써서 saveNote(merge)가 누적 지식을 통째로 덮어쓴다(기억 유실 실측 2026-07-19).
  let noteTitles = [];
  const noteCtx = [];
  try {
    const entries = [];
    // 스캐폴드 가이드(argo-사용법)는 지식 노트가 아니라 안내문 — 정제 컨텍스트에 주면 LLM이 재정제해 유사 사본을 만든다(실측)
    for (const n of (await readdir(p.notes)).filter((f) => f.endsWith('.md') && f !== 'argo-사용법.md')) {
      const file = join(p.notes, n);
      entries.push({ file, mtime: (await stat(file)).mtimeMs });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const [i, e] of entries.entries()) {
      const raw = await readFile(e.file, 'utf8');
      const title = raw.match(/^#\s*(.+)$/m)?.[1];
      if (!title) continue;
      noteTitles.push(title);
      if (i < 12) {
        // 링크 섹션·frontmatter·제목행 제거한 순수 본문만 — 프롬프트 예산 절약(개당 800자)
        const { body } = splitLinkSections(raw.replace(/^---[\s\S]*?---\n/, ''));
        noteCtx.push({ title, body: body.replace(/^#[^\n]*\n/, '').trim().slice(0, 800) });
      }
    }
  } catch { /* 노트 폴더 없음 */ }

  const t0 = Date.now();
  // 러너 독립(runOneShot) — Claude 없이 Codex/Gemini/GLM만 연결한 회사도 기억 정리가 돈다.
  // (이전: SDK 직호출 + env 미주입 — 호스트 Claude 로그인에만 의존해 BYOK 웹 사용자·타 러너 사용자는 조용히 실패)
  // model은 claude 러너일 때만 haiku 적용(정리는 잔일 — 저비용), maxTurns 4 = 도구 거부돼도 최종 답까지.
  const { runner, text: out, usage, costUsd } = await runOneShot(wsId, PROMPT(text, noteTitles, lang, noteCtx),
    { lang, model: 'claude-haiku-4-5-20251001', maxTurns: 4 });
  await appendUsage(wsId, { kind: 'consolidate', slug: '', runner, usage, costUsd, ms: Date.now() - t0 });

  let parsed;
  try {
    parsed = JSON.parse(out.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''));
  } catch {
    await appendEvent(wsId, { type: 'memory', ok: false, error: `정리 결과 파싱 실패: ${out.slice(0, 80)}` });
    throw new Error(`정리 결과 파싱 실패: ${out.slice(0, 120)}`);
  }

  const written = [];
  for (const n of (parsed.notes ?? []).slice(0, 8)) {
    if (!n.title?.trim() || !n.content?.trim()) continue;
    const { file } = await saveNote(wsId, n.title, n.content, { merge: true });
    await appendSourceLinks(file, sources); // 이 결론의 근거 일지 — 드릴다운 경로(섹션 파서 경유)
    written.push(n.title.trim());
  }
  await writeJsonAtomic(WATERMARK(wsId), next); // 정리 성공 후에만 전진
  await updateIndex(wsId);
  if (written.length) await appendEvent(wsId, { type: 'memory', ok: true, notes: written });
  return { notes: written };
}

/** ISO 주차 라벨 — 주간 파일명(2026-W28)용. */
function weekLabel(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const target = new Date(d);
  target.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // 그 주의 목요일 = ISO 주차 기준
  const jan4 = new Date(target.getFullYear(), 0, 4);
  const week = 1 + Math.round(((target - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 주간 롤업 — 7일 지난 일별 일지를 주간 파일로 접는다(턴 제목만 보존, 본문은 .archive/ 원본에).
 * 정제(워터마크)가 아직 안 소화한 일지는 건드리지 않는다.
 */
export async function rollupJournals(wsId) {
  const dir = paths(wsId).journal;
  let names = [];
  try { names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(n)).sort(); } catch { return { rolled: 0 }; }
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const mark = await readWatermark(wsId);
  const archive = join(dir, '.archive');
  let rolled = 0;

  for (const n of names) {
    const day = n.slice(0, 10);
    if (day >= cutoff) continue;
    const file = join(dir, n);
    const size = (await stat(file)).size;
    if ((mark.offsets[n] ?? 0) < size) continue; // 아직 정제 안 된 내용 — 다음 정리 후에 접는다

    const text = await readFile(file, 'utf8');
    const label = text.match(/^# \d{4}-\d{2}-\d{2} (.+?) 일지/m)?.[1] ?? n.slice(11).replace(/\.md$/, '');
    const gists = [...text.matchAll(/^## (\d{2}:\d{2} — .+)$/gm)].map((m) => `- ${m[1]}`);
    const weekly = join(dir, `${weekLabel(day)}.md`);
    let head = '';
    // [[..]] 리터럴 금지 — 인덱스·그래프가 위키링크로 파싱해 존재하지 않는 문서를 가리키는 유령 링크가 된다
    try { await stat(weekly); } catch { head = `# ${weekLabel(day)} 주간 일지\n\n상세 원본은 journal/.archive/ 폴더의 일별 파일에 보관됨.\n`; }
    await appendFile(weekly, `${head}\n## ${day} ${label}\n${gists.join('\n') || '- (기록 없음)'}\n`);
    await mkdir(archive, { recursive: true });
    await rename(file, join(archive, n));
    rolled += 1;
  }
  if (rolled) await updateIndex(wsId);
  return { rolled };
}
