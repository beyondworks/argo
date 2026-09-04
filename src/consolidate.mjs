// 기억 정리 데몬 — 사람 뇌의 수면 정리처럼, 일지(원수)를 읽어 주제 노트(정제수)를 생성/갱신한다.
// 하이쿠 1턴/일/회사 — 원본 일지는 삭제하지 않는다(감사 가능). 워터마크로 새 내용만 정리.
// + 주간 롤업: 7일 지난 일지는 주간 요약 1파일로 접히고 원본은 .archive/로 — 기억은 쌓일수록 정제된다.
import { readFile, readdir, stat, rename, mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, loadCompany } from './workspace.mjs';
import { GUIDE_NOTE } from './provision.mjs'; // 스캐폴드 안내 노트 파일명(단일 진실)
import { runOneShot } from './oneshot.mjs'; // 러너 독립 — 어떤 러너든 연결만 되면 기억 정리가 돈다
import { saveNote, updateIndex, splitLinkSections, appendSourceLinks } from './memory.mjs';
import { appendUsage } from './usage.mjs';
import { isBilledRunner } from './runners.mjs'; // billed 각인 — 순환 없음(2R 검수 확인)
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';

const WATERMARK = (wsId) => join(paths(wsId).vault, '.consolidate.json');
// 정리 모델 — A/B 실측(2026-09-04, 같은 14KB 청크·같은 프롬프트): sonnet 5가 주제 포착 3/3·기존 제목 재사용·JSON 정상에 비용도
// 4.6(0.19$)·4.5(0.38$)보다 낮은 0.14$. haiku는 주제 1/3만 건지고 기존 노트 옆에 사본을 만들었다(유건 승인으로 교체).
// 실운영 청크(가져온 200KB) 1회 실측: 264초·0.74$(출력 22.6K 토큰) — 밤당 7MB ≈ 36청크 ≈ 27$(가격표 기준, 구독은 청구 0).
export const CONSOLIDATE_MODEL = 'claude-sonnet-5';
// 청크 크기(바이트) — 회당 고정 오버헤드(시스템 프롬프트·노트 발췌 ≈ 20K 토큰)가 크므로 청크를 키워 회수를 줄인다.
// 가져온(imported) 일지는 이미 세션 요약본이라 200KB, 크루 일지는 정제 품질을 위해 60KB. 한 파일이 청크보다 크면
// 줄 경계에서 잘라 다음 청크가 이어 받는다(옛 구현은 통째로 읽고 잘라 버려 큰 파일 뒷부분이 영영 정리에서 빠졌다).
const CHUNK_CREW = 60_000;
const CHUNK_IMPORTED = 200_000;
const IMPORTED_RE = /-imported\.md$/;
export const chunkCapFor = (name) => (IMPORTED_RE.test(name) ? CHUNK_IMPORTED : CHUNK_CREW);
// 야간 루프 상한(consolidateBacklog) — 21MB 백로그를 3밤에(유건 지시) → 밤당 7MB. 청구 러너(BYOK)는 비용 상한으로 5청크.
export const NIGHTLY_BYTES = 7 * 1024 * 1024;
export const BILLED_MAX_CHUNKS = 5;
const MIN_ROOM = 4096; // 청크 남은 자리가 이보다 작으면 다음 파일을 시작하지 않는다(자투리 조각 방지). 줄 경계 절단도 이만큼은 전진해야 채택
const NOTE_CAP = 40; // 청크당 저장 노트 상한 — 200KB 청크는 주제가 십수 개일 수 있다(옛 8은 조용한 유실 창 — 검수 HIGH-1). 초과는 이벤트로 남긴다
const SOURCE_LINK_CAP = 20; // 노트 하나에 붙이는 근거 일지 링크 상한 — 청크 하나가 30여 파일이라 링크 섹션이 본문을 삼킨다(검수 LOW)
const REPAIR_MAX = 60_000; // 이보다 긴 출력은 복구를 시도하지 않는다 — 잘린 JSON을 "고치면" 노트가 빠진 채 문법만 맞아 워터마크가 전진한다
const MIN_TEXT = 400; // 소량이면 스킵(워터마크도 안 움직임) — 정제할 만큼 쌓일 때까지 기다린다
let oneShot = runOneShot;
export const _setOneShotForTest = (fn) => { oneShot = fn ?? runOneShot; };

const PROMPT = (journals, noteTitles, lang = 'ko', noteCtx = []) => lang === 'en' ? `You are the librarian of the company's memory. Read the journals (raw conversations) below and distill only knowledge worth reusing into topic notes.
Do not call any tools — the text provided below is all the material you have.

Rules:
- First list every topic that appears in the journals, then write exactly one note per topic (a missed topic = lost memory). Do not merge different topics into one note, and do not split one topic across two notes.
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
- 먼저 일지에 등장한 주제를 전부 나열한 뒤, 주제마다 노트를 정확히 1개씩 써라(주제 누락 = 기억 유실). 서로 다른 주제를 한 노트에 합치지 말고, 같은 주제를 두 노트로 쪼개지 마라.
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

/** 워터마크 이후의 새 일지 내용을 **청크 상한까지** 모은다(export: 순수 청킹 테스트용).
    sources = 이번 정리에 기여한 일지(근거 링크용). 청크 상한은 첫 미정리 파일의 종류(크루/가져온)가 정한다.
    파일이 상한보다 크면 상한 안의 마지막 줄바꿈에서 잘라 워터마크를 그만큼만 전진 — 다음 청크가 이어 받는다. */
export async function gatherNewJournal(wsId, mark) {
  const dir = paths(wsId).journal;
  let names = [];
  // 일별(YYYY-MM-DD-*)만 — 주간 롤업(YYYY-Wnn.md)은 정리의 산출물이라 다시 섭취하면 자기 요약을 재정리하는 루프가 된다
  try { names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}-.+\.md$/.test(n)).sort(); } catch { return { text: '', next: mark, sources: [], consumed: 0, remaining: 0 }; }
  let text = '';
  let used = 0; // 이번 청크에 담은 바이트
  let cap = 0;  // 첫 미정리 파일이 정한다
  let consumed = 0; let remaining = 0;
  const sources = [];
  const next = { v: 2, offsets: { ...mark.offsets } };
  for (const n of names) {
    const file = join(dir, n);
    // Buffer로 읽어 바이트 기준으로 자른다 — 워터마크 오프셋 단위는 바이트. buf.length를 쓰면 읽기·크기가 같은 스냅샷이라 레이스도 없다.
    let buf;
    try { buf = await readFile(file); } catch { continue; } // readdir 뒤 사라진 파일(수동 롤업·동기화 삭제) — 그 밤 루프를 통째로 던지지 않는다
    const size = buf.length;
    const done = Math.min(mark.offsets[n] ?? 0, size);
    if (size <= done) { next.offsets[n] = done; continue; }
    if (!cap) cap = chunkCapFor(n);
    const room = cap - used;
    // 청크가 찼거나 남은 자리가 자투리(4KB 미만)면 손대지 않는다 — 다음 파일 앞 몇 줄만 떼어 오면 문맥이 끊긴 조각이 된다
    if (room < MIN_ROOM) { remaining += size - done; next.offsets[n] = done; continue; }
    let end = Math.min(size, done + room);
    if (end < size) { // 파일 중간 절단 — 상한 안의 마지막 줄바꿈까지, 단 그래도 MIN_ROOM 이상 전진할 때만(검수 HIGH-2: 창 안 유일한
      // 줄바꿈이 done 바로 뒤면 몇 바이트짜리 청크가 되어 MIN_TEXT 미만 스킵 → 워터마크가 영영 안 움직였다). 아니면 하드 컷 —
      // UTF-8 연속 바이트(10xxxxxx) 앞으로 물러나 글자를 쪼개지 않는다(검수 LOW: 하드 컷이 U+FFFD를 만들었다).
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl > done && nl + 1 - done >= MIN_ROOM) end = nl + 1;
      else while (end > done + 1 && (buf[end] & 0xc0) === 0x80) end -= 1;
    }
    text += `\n[${n}]\n${buf.subarray(done, end).toString('utf8')}`;
    sources.push(`journal/${n.replace(/\.md$/, '')}`);
    next.offsets[n] = end;
    used += end - done; consumed += end - done; remaining += size - end;
  }
  return { text, next, sources, consumed, remaining };
}

/** LLM 출력 → {notes} 파싱(export: 테스트용). 코드펜스 관용. 실패는 null. */
export function parseNotes(out) {
  try {
    const parsed = JSON.parse(String(out ?? '').trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''));
    return parsed && typeof parsed === 'object' && Array.isArray(parsed.notes) ? parsed : null;
  } catch { return null; }
}
const REPAIR_PROMPT = (bad, lang) => (lang === 'en'
  ? `The text below was meant to be JSON of the form {"notes":[{"title":"...","content":"..."}]} but does not parse. Return ONLY the corrected JSON (no code fences, no explanation) — escape quotes and newlines inside strings, keep every note and its full content.\n\n${bad}`
  : `아래 텍스트는 {"notes":[{"title":"...","content":"..."}]} 형태의 JSON이어야 하는데 파싱되지 않는다. 문자열 안 따옴표·줄바꿈을 이스케이프해 **수정된 JSON만** 출력하라(코드펜스·설명 금지). 노트와 본문은 하나도 빼지 마라.\n\n${bad}`);

/** 정리 1회 실행 — 반환: 갱신/생성된 노트 목록. 새 내용 없으면 빈 배열. */
export async function consolidateMemory(wsId) {
  const mark = await readWatermark(wsId);
  const { text, next, sources, consumed, remaining } = await gatherNewJournal(wsId, mark);
  if (text.trim().length < MIN_TEXT) return { notes: [], consumed: 0, remaining, billed: false };

  const p = paths(wsId);
  const { lang = 'ko' } = await loadCompany(wsId).catch(() => ({})); // 시스템 언어 — 주제 노트 정제 언어(기존 회사=ko 폴백)
  // 제목 전체 + 최근 12개 노트의 본문 발췌 — 본문 없이 제목만 주면 LLM이 기존 결론을 모른 채 본문을
  // 새로 써서 saveNote(merge)가 누적 지식을 통째로 덮어쓴다(기억 유실 실측 2026-07-19).
  let noteTitles = [];
  const noteCtx = [];
  try {
    const entries = [];
    // 스캐폴드 가이드(argo-사용법)는 지식 노트가 아니라 안내문 — 정제 컨텍스트에 주면 LLM이 재정제해 유사 사본을 만든다(실측)
    for (const n of (await readdir(p.notes)).filter((f) => f.endsWith('.md') && f !== GUIDE_NOTE)) {
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
  // 2턴 상한 — 프롬프트가 도구 금지를 말해도 턴이 열려 있으면 파일을 읽으러 다녀 비용이 5배로 뛰었다(A/B 실측). readOnly는 CLI 경로
  // (codex/agy 샌드박스·caps)를 막고, SDK 경로는 이미 allowedTools []라 무효 — 비용 절감은 maxTurns가 담당한다(검수 확인).
  // 배치 작업(새벽 자동 실행, 사용자 대기 없음)이라 공통 기본(120s)보다 넉넉히 — 상한의 목적은
  // 지연 SLO가 아니라 "영원히 안 끝나는 것"을 끊어 스케줄러 in-flight 표시를 반드시 풀어주는 것이다.
  const { runner, text: out, usage, costUsd } = await oneShot(wsId, PROMPT(text, noteTitles, lang, noteCtx),
    { lang, model: CONSOLIDATE_MODEL, maxTurns: 2, readOnly: true, timeoutMs: 10 * 60_000 });
  // billed 각인 — 구독 러너의 기억 정리 턴 금액이 청구로 새지 않게(검수 2026-07-27 부수 발견)
  // 판정 실패는 청구로 본다(fail-closed) — 자격 파일 손상 시 1회 throw가 명세라, undefined로 두면 비용 상한이 조용히 사라진다(검수 MEDIUM-1)
  const billed = await isBilledRunner(wsId, runner).catch(() => true);
  await appendUsage(wsId, { kind: 'consolidate', slug: '', runner, usage, costUsd, ms: Date.now() - t0, billed });

  let parsed = parseNotes(out);
  if (!parsed && out.length <= REPAIR_MAX) { // JSON 복구 1회(출력이 상한 안일 때만 — 잘린 JSON을 고치면 노트가 빠진 채 통과한다) — 본문 안 따옴표 미이스케이프 같은 형식 오류로 하루치 정리가 통째로 날아가지 않게(A/B: sonnet 4.6이 실증)
    const fix = await oneShot(wsId, REPAIR_PROMPT(out.slice(0, 60_000), lang), { lang, model: CONSOLIDATE_MODEL, maxTurns: 1, readOnly: true, timeoutMs: 3 * 60_000 });
    await appendUsage(wsId, { kind: 'consolidate', slug: '', runner: fix.runner, usage: fix.usage, costUsd: fix.costUsd, ms: 0, billed });
    parsed = parseNotes(fix.text);
  }
  if (!parsed) {
    await appendEvent(wsId, { type: 'memory', ok: false, error: `정리 결과 파싱 실패: ${out.slice(0, 80)}` });
    throw new Error(`정리 결과 파싱 실패: ${out.slice(0, 120)}`);
  }

  const written = [];
  const all = parsed.notes ?? [];
  if (all.length > NOTE_CAP) { // 조용히 버리지 않는다 — 초과 주제는 사용자가 알아야 다시 정리시킬 수 있다
    console.warn(`[argo] 기억 정리: 노트 ${all.length}개 중 ${NOTE_CAP}개만 저장(${wsId}) — 청크가 너무 크다`);
    await appendEvent(wsId, { type: 'memory', ok: false, error: `노트 ${all.length}개 중 ${NOTE_CAP}개만 저장 — 초과: ${all.slice(NOTE_CAP).map((n) => n.title).join(', ').slice(0, 200)}` });
  }
  for (const n of all.slice(0, NOTE_CAP)) {
    if (!n.title?.trim() || !n.content?.trim()) continue;
    const { file } = await saveNote(wsId, n.title, n.content, { merge: true });
    await appendSourceLinks(file, sources.slice(0, SOURCE_LINK_CAP)); // 이 결론의 근거 일지 — 드릴다운 경로(섹션 파서 경유)
    written.push(n.title.trim());
  }
  await writeJsonAtomic(WATERMARK(wsId), next); // 정리 성공 후에만 전진
  await updateIndex(wsId);
  if (written.length) await appendEvent(wsId, { type: 'memory', ok: true, notes: written });
  return { notes: written, consumed, remaining, billed: !!billed };
}

/** 야간 루프 — 청크를 연속으로 정리한다. 멈춤 조건(먼저 닿는 것): 잔량 소진 · 밤당 바이트 상한 · 마감 시각 · 청구 러너 청크 상한.
    실패는 던진다(워터마크는 성공한 청크까지 전진해 있으므로 스케줄러 재시도가 이어 받는다). 반환은 로그·테스트용 요약. */
export async function consolidateBacklog(wsId, { deadlineMs = Infinity, nightlyBytes = NIGHTLY_BYTES, billedMaxChunks = BILLED_MAX_CHUNKS, maxChunks = 500, now = () => Date.now(), onChunk = null } = {}) {
  let chunks = 0; let bytes = 0; const notes = []; let stoppedBy = 'drained';
  if (onChunk) await Promise.resolve().then(() => onChunk({ chunks, bytes })).catch(() => {}); // 진입 직후 1회 — 첫 청크가 5분을 넘어도 선점 창이 열리지 않게(검수 권고)
  for (;;) {
    if (now() >= deadlineMs) { stoppedBy = 'deadline'; break; }
    if (bytes >= nightlyBytes) { stoppedBy = 'nightly-bytes'; break; }
    if (chunks >= maxChunks) { stoppedBy = 'max-chunks'; break; }
    const r = await consolidateMemory(wsId);
    if (!r.consumed) { // 소량 스킵 또는 잔량 0
      stoppedBy = r.remaining ? 'too-small' : 'drained';
      if (r.remaining) console.warn(`[argo] 기억 정리: ${wsId} 잔량 ${Math.round(r.remaining / 1024)}KB인데 청크가 소량이라 스킵 — 일지 분할·워터마크 확인`);
      break;
    }
    chunks += 1; bytes += r.consumed; notes.push(...r.notes);
    if (onChunk) await Promise.resolve().then(() => onChunk({ chunks, bytes })).catch(() => {}); // 스케줄러 선점 스탬프 연장(4시간 루프 동안 다른 기기·재기동이 두 번째 루프를 열지 않게)
    console.log(`[argo] 기억 정리 청크 ${chunks}: ${wsId} ${Math.round(r.consumed / 1024)}KB → 노트 ${r.notes.length}, 잔량 ${Math.round(r.remaining / 1024)}KB`);
    if (r.billed && chunks >= billedMaxChunks) { stoppedBy = 'billed-cap'; break; }
    if (!r.remaining) { stoppedBy = 'drained'; break; }
  }
  return { chunks, bytes, notes, stoppedBy };
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
    // append → rename 순서라 rename만 실패하면(파일 잠금·권한) 원본이 journal/에 남아 다음 실행이
    // 같은 블록을 또 접는다. 스케줄러 재시도 도입으로 노출이 커졌으므로 여기서 멱등을 보장한다.
    // 키는 **원본 파일명**(= 날짜+slug, 고유)이다 — 표시용 헤딩(날짜+크루 이름)을 키로 쓰면
    // 동명 크루에서 뒤 크루의 하루치가 append 없이 아카이브돼 통째로 유실된다(검수 실측 2026-07-27:
    // persona.mjs가 동명 영입을 허용해 slug만 -2가 붙고 이름은 같아진다). 마커는 HTML 주석이라
    // 읽는 사람에겐 안 보이고 파서(위키링크·헤딩)도 건드리지 않는다.
    let weeklyText = '';
    try { weeklyText = await readFile(weekly, 'utf8'); } catch { /* 첫 주간 파일 */ }
    const marker = `<!-- rolled: ${n} -->`;
    if (!weeklyText.includes(marker)) {
      // [[..]] 리터럴 금지 — 인덱스·그래프가 위키링크로 파싱해 존재하지 않는 문서를 가리키는 유령 링크가 된다
      const head = weeklyText ? '' : `# ${weekLabel(day)} 주간 일지\n\n상세 원본은 journal/.archive/ 폴더의 일별 파일에 보관됨.\n`;
      await appendFile(weekly, `${head}\n## ${day} ${label}\n${marker}\n${gists.join('\n') || '- (기록 없음)'}\n`);
    }
    await mkdir(archive, { recursive: true });
    await rename(file, join(archive, n));
    rolled += 1;
  }
  if (rolled) await updateIndex(wsId);
  return { rolled };
}
