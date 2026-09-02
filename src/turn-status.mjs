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

// 같은 상태 파일의 읽기-수정-쓰기를 프로세스 안에서 직렬화한다 — 하트비트 틱(현재 단계 재기록)과 스트리밍
// 이벤트(단계 변경)가 겹치면 틱이 옛 단계를 되돌려 쓰고, 다음 이벤트가 없는 긴 도구 구간 동안 그 역행이 굳는다
// (핀 테스트 실측: 5ms 틱에서 'shell'→'runner'). 상태 쓰기는 전부 앱 서버 프로세스 안이라 파일 락은 불필요.
// clear도 같은 사슬을 탄다 — 먼저 줄 선 틱은 끝나고 지워지며, 뒤에 줄 선 틱은 alive 게이트로 무동작.
const chains = new Map(); // 파일 경로 → 대기열 꼬리
function serialized(key, fn) {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
// 직렬화 안에서만 부른다 — 상태 파일은 캐시성이라 손상은 관용(readJsonLenient). writeJsonAtomic가 mkdir까지 처리.
async function writeStatus(f, stage, detail, partial) {
  const prev = await readJsonLenient(f, {});
  await writeJsonAtomic(f, {
    stage, detail,
    // partial — 완료 전 크루가 이미 말한 텍스트(스트리밍 체감). 미전달 시 이전 값 유지, 뒤 4000자만
    partial: String(partial ?? prev.partial ?? '').slice(-4000),
    startedAt: prev.startedAt ?? Date.now(), ts: Date.now(),
  });
}

export async function setTurnStatus(wsId, slug, stage, detail = '', partial) {
  try {
    const f = file(wsId, slug);
    await serialized(f, () => writeStatus(f, stage, detail, partial));
  } catch { /* 상태 표시는 베스트에포트 */ }
}

export async function clearTurnStatus(wsId, slug) {
  try {
    const f = file(wsId, slug);
    await serialized(f, () => rm(f, { force: true }));
  } catch { /* 없으면 그만 */ }
}

/** 하트비트 — 턴이 도는 동안 상태 파일의 ts를 주기 갱신해 2분 신선도 창 안에 붙든다.
    스트리밍·도구 이벤트가 없는 긴 구간(CLI 러너 턴 전체, SDK 러너의 긴 셸 도구·memory 단계)에서 상태가 낡아
    **턴이 살아 있는데 사이드바 링·작업 독 배지·진행 카드가 꺼지고**, 그 순간 안읽음 점이 거짓 '답변 도착'으로
    켜지던 결함(분리 검수 2026-09-02 MEDIUM-1 — CLI 러너만 2분에 표지가 죽어 러너 중립성 위반).
    room.mjs withRoomTurnStatus와 같은 규약: 틱 직렬화 + alive 게이트 + stop()이 진행 중 틱을 기다린 뒤 돌아온다
    (해제 직후 착지한 틱이 clearTurnStatus 뒤 상태를 되살리면 화면이 2분간 거짓 '작성 중'). 틱은 지금 stage·detail을
    읽어 그대로 다시 쓴다(partial·startedAt은 setTurnStatus가 보존) — 읽기와 쓰기 사이 찰나의 역행은 다음 이벤트가
    덮는다. stop()은 멱등 — 모든 탈출 경로(성공·실패·재귀 재시도·finally)에서 불러도 안전하다.
    unref — 프로세스 종료를 잡지 않고, 프로세스가 죽으면 2분 뒤 자연 만료된다(고아 방어는 그대로). */
export function keepTurnStatusFresh(wsId, slug, stage, detail = '', { heartbeatMs = 30_000 } = {}) {
  const f = file(wsId, slug);
  let alive = true; let tick = Promise.resolve();
  // 틱 = 직렬화된 읽기→쓰기 한 묶음(스트리밍 쓰기와 못 겹친다). 낡았으면(2분 창 밖 — 이벤트 루프 정체 등) 초기 단계로.
  const beat = () => serialized(f, async () => {
    if (!alive) return;
    const cur = await readJsonLenient(f, null);
    if (!alive) return;
    const fresh = !!(cur?.ts && Date.now() - cur.ts < 120_000);
    await writeStatus(f, fresh ? cur.stage : stage, fresh ? (cur.detail ?? '') : detail);
  });
  const hb = setInterval(() => { tick = tick.then(beat).catch(() => {}); }, heartbeatMs);
  hb.unref?.();
  return {
    /** clearTurnStatus **앞에서** await — 진행 중 틱을 끝까지 기다린 뒤 돌아온다. 여러 번 불러도 된다. */
    async stop() { alive = false; clearInterval(hb); await tick; },
  };
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
