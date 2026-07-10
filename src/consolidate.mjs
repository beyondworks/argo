// 기억 정리 데몬 — 사람 뇌의 수면 정리처럼, 일지(원수)를 읽어 주제 노트(정제수)를 생성/갱신한다.
// 하이쿠 1턴/일/회사 — 원본 일지는 삭제하지 않는다(감사 가능). 워터마크로 새 내용만 정리.
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { saveNote, updateIndex } from './memory.mjs';
import { appendUsage } from './usage.mjs';

const WATERMARK = (wsId) => join(paths(wsId).vault, '.consolidate.json');
const CAP = 14_000; // 정리 1회당 읽는 일지 총량 — 넘치면 다음 실행이 이어서 정리

const PROMPT = (journals, noteTitles) => `당신은 회사 기억의 사서다. 아래 일지(대화 원본)를 읽고 재사용 가치가 있는 지식만 주제 노트로 정제하라.
도구를 호출하지 마라 — 아래 제공된 텍스트가 자료의 전부다.

규칙:
- 주제 노트는 주제당 1개가 단일 진실이다. 기존 노트 제목과 같은 주제면 그 제목을 그대로 써서 갱신하라(새 제목 남발 금지).
- 노트 내용은 "다음에 이 주제를 다룰 크루가 바로 쓸 수 있는" 결론·결정·수치·규칙 중심으로. 대화 인용·과정 서술 금지.
- 일지에 정제할 가치가 있는 내용이 없으면 빈 배열을 반환하라.
- 정확히 JSON만 출력(코드펜스·설명 금지): {"notes":[{"title":"...","content":"마크다운 본문"}]}

기존 주제 노트 제목: ${noteTitles.length ? noteTitles.join(' | ') : '(없음)'}

--- 일지 ---
${journals}`;

async function readWatermark(wsId) {
  try { return JSON.parse(await readFile(WATERMARK(wsId), 'utf8')); } catch { return { offsets: {} }; }
}

/** 워터마크 이후의 새 일지 내용만 모은다. */
async function gatherNewJournal(wsId, mark) {
  const dir = paths(wsId).journal;
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort(); } catch { return { text: '', next: mark }; }
  let text = '';
  const next = { offsets: { ...mark.offsets } };
  for (const n of names) {
    const file = join(dir, n);
    const size = (await stat(file)).size;
    const done = mark.offsets[n] ?? 0;
    if (size <= done || text.length > CAP) { next.offsets[n] = Math.min(done, size); continue; }
    const body = (await readFile(file, 'utf8')).slice(done);
    text += `\n[${n}]\n${body}`;
    next.offsets[n] = size;
  }
  return { text: text.slice(0, CAP + 4000), next };
}

/** 정리 1회 실행 — 반환: 갱신/생성된 노트 목록. 새 내용 없으면 빈 배열. */
export async function consolidateMemory(wsId) {
  const mark = await readWatermark(wsId);
  const { text, next } = await gatherNewJournal(wsId, mark);
  // 소량이면 스킵(워터마크도 안 움직임) — 정제할 만큼 쌓일 때까지 기다린다
  if (text.trim().length < 400) return { notes: [] };

  const p = paths(wsId);
  let noteTitles = [];
  try {
    for (const n of (await readdir(p.notes)).filter((f) => f.endsWith('.md'))) {
      const t = (await readFile(join(p.notes, n), 'utf8')).match(/^#\s*(.+)$/m)?.[1];
      if (t) noteTitles.push(t);
    }
  } catch { /* 노트 폴더 없음 */ }

  let out = '';
  const t0 = Date.now();
  for await (const msg of query({
    prompt: PROMPT(text, noteTitles),
    options: {
      cwd: p.root,
      allowedTools: [],
      settingSources: [],
      maxTurns: 4, // 모델이 도구를 시도하다 거부당해도 최종 답까지 이어지게 여유
      model: 'claude-haiku-4-5-20251001', // 정리는 잔일 — 저비용 모델
    },
  })) {
    if (msg.type === 'result') {
      await appendUsage(wsId, { kind: 'consolidate', slug: '', usage: msg.usage, costUsd: msg.total_cost_usd, ms: Date.now() - t0 });
      if (msg.subtype === 'success') out = msg.result;
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(out.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, ''));
  } catch {
    throw new Error(`정리 결과 파싱 실패: ${out.slice(0, 120)}`);
  }

  const written = [];
  for (const n of (parsed.notes ?? []).slice(0, 8)) {
    if (!n.title?.trim() || !n.content?.trim()) continue;
    await saveNote(wsId, n.title, n.content, { merge: true });
    written.push(n.title.trim());
  }
  await writeFile(WATERMARK(wsId), JSON.stringify(next, null, 2)); // 정리 성공 후에만 전진
  await updateIndex(wsId);
  return { notes: written };
}
