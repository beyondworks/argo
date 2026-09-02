// 턴 진행 단계 — "작성중" 한 마디로 뭉개지 않는다(Hermes 교훈: 지연과 먹통을 구분 못 하면 신뢰 붕괴).
// chat이 단계를 파일로 남기고, 크루 화면이 폴링해 보여준다.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${slug.replace(/[^a-z0-9-]/g, '')}.status.json`);

// 안정적인 stage 코드만 기록한다 — 사람이 읽는 라벨은 클라이언트가 i18n으로 번역한다(영어 회사에 한국어
// 진행 라벨이 노출되던 다국어 규칙 위반 수정). detail(파일명·명령 등 고유값)은 번역 대상이 아니라 그대로.
const TOOL_STAGE = [
  [/^(Read|Glob|Grep)$/, 'memory'],
  [/^(Write|Edit|NotebookEdit)$/, 'write'],
  [/^Bash$/, 'shell'],
  [/^(WebFetch|WebSearch)$/, 'web'],
  [/^mcp__crew__delegate$/, 'delegate'],
  [/^mcp__crew__request_approval$/, 'approval'],
  [/^mcp__/, 'tool'],
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
  for (const [re, code] of TOOL_STAGE) if (re.test(toolName)) return code;
  return 'work';
}

export async function setTurnStatus(wsId, slug, stage, detail = '', partial) {
  try {
    // 상태 파일은 캐시성 — 손상은 관용(readJsonLenient). writeJsonAtomic가 mkdir까지 처리.
    const prev = await readJsonLenient(file(wsId, slug), {});
    await writeJsonAtomic(file(wsId, slug), {
      stage, detail,
      // partial — 완료 전 크루가 이미 말한 텍스트(스트리밍 체감). 미전달 시 이전 값 유지, 뒤 4000자만
      partial: String(partial ?? prev.partial ?? '').slice(-4000),
      startedAt: prev.startedAt ?? Date.now(), ts: Date.now(),
    });
  } catch { /* 상태 표시는 베스트에포트 */ }
}

export async function clearTurnStatus(wsId, slug) {
  try { await rm(file(wsId, slug), { force: true }); } catch { /* 없으면 그만 */ }
}

/** 2분 넘게 갱신이 없으면 죽은 상태로 보고 무시한다. 반환: { stage, detail, partial, startedAt } | null */
export async function getTurnStatus(wsId, slug) {
  try {
    const s = await readJsonLenient(file(wsId, slug), null);
    if (!s || !s.ts) return null;
    return Date.now() - s.ts < 120_000
      ? { stage: s.stage, detail: s.detail ?? '', partial: s.partial ?? '', startedAt: s.startedAt ?? s.ts }
      : null;
  } catch {
    return null;
  }
}
