// 기억 정리 데몬 — 사람 뇌의 수면 정리처럼, 일지(원수)를 읽어 주제 노트(정제수)를 생성/갱신한다.
// 하이쿠 1턴/일/회사 — 원본 일지는 삭제하지 않는다(감사 가능). 워터마크로 새 내용만 정리.
// + 주간 롤업: 7일 지난 일지는 주간 요약 1파일로 접히고 원본은 .archive/로 — 기억은 쌓일수록 정제된다.
import { readFile, writeFile, readdir, stat, rename, mkdir, appendFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { paths } from './workspace.mjs';
import { saveNote, updateIndex } from './memory.mjs';
import { appendUsage } from './usage.mjs';
import { appendEvent } from './events.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';

const WATERMARK = (wsId) => join(paths(wsId).vault, '.consolidate.json');
const CAP = 14_000; // 정리 1회당 읽는 일지 총량 — 넘치면 다음 실행이 이어서 정리

const PROMPT = (journals, noteTitles) => `당신은 회사 기억의 사서다. 아래 일지(대화 원본)를 읽고 재사용 가치가 있는 지식만 주제 노트로 정제하라.
도구를 호출하지 마라 — 아래 제공된 텍스트가 자료의 전부다.

규칙:
- 주제 노트는 주제당 1개가 단일 진실이다. 기존 노트 제목과 같은 주제면 그 제목을 그대로 써서 갱신하라(새 제목 남발 금지).
- 노트 내용은 "다음에 이 주제를 다룰 크루가 바로 쓸 수 있는" 결론·결정·수치·규칙 중심으로. 대화 인용·과정 서술 금지.
- signal gate: "이 기록이 미래의 크루를 더 잘 일하게 하는가?"를 통과하는 내용만 남겨라. 통과 못 하면 버린다.
- 일지에 정제할 가치가 있는 내용이 없으면 빈 배열을 반환하라.
- 정확히 JSON만 출력(코드펜스·설명 금지): {"notes":[{"title":"...","content":"마크다운 본문"}]}

기존 주제 노트 제목: ${noteTitles.length ? noteTitles.join(' | ') : '(없음)'}

--- 일지 ---
${journals}`;

async function readWatermark(wsId) {
  // 워터마크는 재생성 가능(원본 일지가 진실) — 손상은 관용하고 처음부터 재정리(readJsonLenient).
  return readJsonLenient(WATERMARK(wsId), { offsets: {} });
}

/** 워터마크 이후의 새 일지 내용만 모은다. sources = 이번 정리에 기여한 일지(근거 링크용). */
async function gatherNewJournal(wsId, mark) {
  const dir = paths(wsId).journal;
  let names = [];
  try { names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort(); } catch { return { text: '', next: mark, sources: [] }; }
  let text = '';
  const sources = [];
  const next = { offsets: { ...mark.offsets } };
  for (const n of names) {
    const file = join(dir, n);
    const size = (await stat(file)).size;
    const done = mark.offsets[n] ?? 0;
    if (size <= done || text.length > CAP) { next.offsets[n] = Math.min(done, size); continue; }
    const body = (await readFile(file, 'utf8')).slice(done);
    text += `\n[${n}]\n${body}`;
    sources.push(`journal/${n.replace(/\.md$/, '')}`);
    next.offsets[n] = size;
  }
  return { text: text.slice(0, CAP + 4000), next, sources };
}

/** 노트에 "## 근거" 링크 추가 — 결론이 어느 일지에서 왔는지 역추적(투명성 원칙). */
async function addSources(file, rels) {
  let text = await readFile(file, 'utf8');
  const fresh = rels.filter((r) => !text.includes(`[[${r}]]`));
  if (!fresh.length) return;
  if (!/\n## 근거\n/.test(text)) text = `${text.trimEnd()}\n\n## 근거\n`;
  else text = text.trimEnd() + '\n';
  await writeJsonAtomic(file, `${text}${fresh.map((r) => `- [[${r}]]`).join('\n')}\n`);
}

/** 정리 1회 실행 — 반환: 갱신/생성된 노트 목록. 새 내용 없으면 빈 배열. */
export async function consolidateMemory(wsId) {
  const mark = await readWatermark(wsId);
  const { text, next, sources } = await gatherNewJournal(wsId, mark);
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
    await appendEvent(wsId, { type: 'memory', ok: false, error: `정리 결과 파싱 실패: ${out.slice(0, 80)}` });
    throw new Error(`정리 결과 파싱 실패: ${out.slice(0, 120)}`);
  }

  const written = [];
  for (const n of (parsed.notes ?? []).slice(0, 8)) {
    if (!n.title?.trim() || !n.content?.trim()) continue;
    const { file } = await saveNote(wsId, n.title, n.content, { merge: true });
    await addSources(file, sources); // 이 결론의 근거 일지 — 드릴다운 경로
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
    try { await stat(weekly); } catch { head = `# ${weekLabel(day)} 주간 일지\n\n상세 원본은 보관됨 — 필요하면 [[journal/.archive]]의 일별 파일 참조.\n`; }
    await appendFile(weekly, `${head}\n## ${day} ${label}\n${gists.join('\n') || '- (기록 없음)'}\n`);
    await mkdir(archive, { recursive: true });
    await rename(file, join(archive, n));
    rolled += 1;
  }
  if (rolled) await updateIndex(wsId);
  return { rolled };
}
