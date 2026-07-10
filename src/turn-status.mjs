// 턴 진행 단계 — "작성중" 한 마디로 뭉개지 않는다(Hermes 교훈: 지연과 먹통을 구분 못 하면 신뢰 붕괴).
// chat이 단계를 파일로 남기고, 크루 화면이 폴링해 보여준다.
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${slug.replace(/[^a-z0-9-]/g, '')}.status.json`);

const TOOL_STAGE = [
  [/^(Read|Glob|Grep)$/, '기억을 살피는 중'],
  [/^(Write|Edit|NotebookEdit)$/, '기록하는 중'],
  [/^Bash$/, '명령 실행 중'],
  [/^(WebFetch|WebSearch)$/, '웹을 살피는 중'],
  [/^mcp__crew__delegate$/, '동료에게 위임 중'],
  [/^mcp__crew__request_approval$/, '결재 올리는 중'],
  [/^mcp__/, '도구 사용 중'],
];

const base = (p) => String(p ?? '').split('/').pop();
/** 도구 입력에서 "무엇을" 하는지 한 조각 — 클로드코드의 도구 라벨처럼. */
export function detailForTool(toolName, input = {}) {
  try {
    if (/^(Read|Write|Edit|NotebookEdit)$/.test(toolName)) return base(input.file_path);
    if (toolName === 'Glob' || toolName === 'Grep') return input.pattern ?? '';
    if (toolName === 'Bash') return String(input.command ?? '').replace(/\s+/g, ' ').slice(0, 48);
    if (toolName === 'WebFetch') return new URL(input.url).hostname;
    if (toolName === 'WebSearch') return String(input.query ?? '').slice(0, 48);
    if (toolName === 'mcp__crew__delegate') return input.to ?? '';
    if (toolName.startsWith('mcp__')) return toolName.replace(/^mcp__/, '').replace(/__/g, ' · ');
  } catch { /* 디테일은 장식 — 실패해도 단계는 남는다 */ }
  return '';
}

export function stageForTool(toolName) {
  for (const [re, label] of TOOL_STAGE) if (re.test(toolName)) return label;
  return '작업 중';
}

export async function setTurnStatus(wsId, slug, stage, detail = '') {
  try {
    await mkdir(paths(wsId).chats, { recursive: true });
    let startedAt = Date.now();
    try { startedAt = JSON.parse(await readFile(file(wsId, slug), 'utf8')).startedAt ?? startedAt; } catch { /* 첫 기록 */ }
    await writeFile(file(wsId, slug), JSON.stringify({ stage, detail, startedAt, ts: Date.now() }));
  } catch { /* 상태 표시는 베스트에포트 */ }
}

export async function clearTurnStatus(wsId, slug) {
  try { await rm(file(wsId, slug), { force: true }); } catch { /* 없으면 그만 */ }
}

/** 2분 넘게 갱신이 없으면 죽은 상태로 보고 무시한다. 반환: { stage, detail, startedAt } | null */
export async function getTurnStatus(wsId, slug) {
  try {
    const s = JSON.parse(await readFile(file(wsId, slug), 'utf8'));
    return Date.now() - s.ts < 120_000 ? { stage: s.stage, detail: s.detail ?? '', startedAt: s.startedAt ?? s.ts } : null;
  } catch {
    return null;
  }
}
