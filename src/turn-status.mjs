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

export function stageForTool(toolName) {
  for (const [re, label] of TOOL_STAGE) if (re.test(toolName)) return label;
  return '작업 중';
}

export async function setTurnStatus(wsId, slug, stage) {
  try {
    await mkdir(paths(wsId).chats, { recursive: true });
    await writeFile(file(wsId, slug), JSON.stringify({ stage, ts: Date.now() }));
  } catch { /* 상태 표시는 베스트에포트 */ }
}

export async function clearTurnStatus(wsId, slug) {
  try { await rm(file(wsId, slug), { force: true }); } catch { /* 없으면 그만 */ }
}

/** 2분 넘게 갱신이 없으면 죽은 상태로 보고 무시한다. */
export async function getTurnStatus(wsId, slug) {
  try {
    const s = JSON.parse(await readFile(file(wsId, slug), 'utf8'));
    return Date.now() - s.ts < 120_000 ? s.stage : null;
  } catch {
    return null;
  }
}
