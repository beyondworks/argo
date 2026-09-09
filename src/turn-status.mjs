// 턴 진행 단계 — "작성중" 한 마디로 뭉개지 않는다(Hermes 교훈: 지연과 먹통을 구분 못 하면 신뢰 붕괴).
// chat이 단계를 파일로 남기고, 크루 화면이 폴링해 보여준다.
import { rm } from 'node:fs/promises';
import { sanitizeFileSlug } from './slug.mjs';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';

const file = (wsId, slug) => join(paths(wsId).chats, `${sanitizeFileSlug(slug)}.status.json`); // 세척 단일 원천(slug.mjs) — thread.mjs와 같은 규칙

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

/* ─── 심박 — 턴이 살아 있는 동안 상태 파일의 ts를 주기 갱신한다 ───
   이벤트가 없는 긴 단계(도구 실행·모델 응답 대기·기억 조회)가 2분을 넘기면 파일이 낡아 **턴이 살아 있는데
   표시가 꺼진다** — 회의실·1:1 대화 양쪽에서 사고 과정이 사라져 회의가 누락된 것처럼 보였다(유건 제보 2026-09-06,
   격리 재현: 150초 지연 스텁에서 memory 단계 2분 뒤 stage null). 회의실 마커(room.mjs withRoomTurnStatus)가 같은
   이유로 하트비트를 갖고 있었고, 크루 상태 파일에는 없었다.
   · setTurnStatus가 키별로 타이머 하나를 켜고 clearTurnStatus가 끈다 — 호출부(chat.mjs) 변경 없음.
   · 키별 쓰기는 **한 체인**으로 직렬화한다 — 심박(읽고 ts만 갱신)이 갱신 쓰기와 엇갈리면 옛 스냅샷이 나중에 착지해
     최신 단계·문장을 되돌린다(회의실 마커 검수 LOW-1과 같은 결함 구조). 심박은 체인에 최대 1개만 대기.
   · 지워진 파일은 되살리지 않는다(심박이 없으면 그만) — 종료 뒤 부활은 거짓 '작성 중'이다.
   · 프로세스가 죽으면 심박도 멈춰 2분 뒤 만료 — 고아 판정(getTurnStatus 120초)은 그대로다. */
let HEARTBEAT_MS = 30_000;
/** 테스트 전용 — 운영 30초를 ms 단위로 줄여 심박·해제 경합을 결정적으로 돌린다. */
export function _setHeartbeatMsForTest(ms) { HEARTBEAT_MS = ms; }
const live = new Map(); // key → { chain, timer, queued }
const keyOf = (wsId, slug) => `${wsId}/${sanitizeFileSlug(slug)}`;
const enqueue = (e, job) => { e.chain = e.chain.then(job, job); return e.chain; }; // 앞 작업 실패에도 이어간다
async function touch(wsId, slug) {
  const s = await readJsonLenient(file(wsId, slug), null);
  if (!s || !s.ts) return; // 지워졌거나 아직 없음 — 되살리지 않는다
  await writeJsonAtomic(file(wsId, slug), { ...s, ts: Date.now() });
}

export async function setTurnStatus(wsId, slug, stage, detail = '', partial, source, thought, steps) {
  const k = keyOf(wsId, slug);
  let e = live.get(k);
  if (!e) {
    e = { chain: Promise.resolve(), timer: null, queued: false };
    live.set(k, e);
    e.timer = setInterval(() => {
      if (e.queued) return; // 체인에 심박은 최대 1개 — 쓰기보다 짧은 주기에서 무한히 쌓이지 않게(회의실 마커와 같은 구조)
      e.queued = true;
      enqueue(e, () => touch(wsId, slug)).catch(() => {}).finally(() => { e.queued = false; });
    }, HEARTBEAT_MS);
    e.timer.unref?.(); // 프로세스 종료를 붙들지 않는다
  }
  await enqueue(e, async () => {
    try {
      // 상태 파일은 캐시성 — 손상은 관용(readJsonLenient). writeJsonAtomic가 mkdir까지 처리.
      // 낡은 파일(120초 무갱신 = 죽은 턴의 잔재 — 크래시·kill로 clear가 못 돈 경우)은 새 턴의 전 상태가 아니다. 그대로 이어받으면
      // startedAt이 몇 십 분 전으로 잡혀 경과가 "31:54"로 뜨고, 옛 partial·thought·source가 새 발언에 섞인다(격리 실측 2026-09-07).
      const prev0 = await readJsonLenient(file(wsId, slug), {});
      const prev = prev0?.ts && Date.now() - prev0.ts < 120_000 ? prev0 : {}; // 120초 = getTurnStatus의 만료 창과 같은 값 — 심박(30초)이 이 창을 덮어야 정상 턴이 잔재로 오인되지 않는다(HEARTBEAT_MS ≪ 120초 결합)
      await writeJsonAtomic(file(wsId, slug), {
        stage, detail,
        // partial — 완료 전 크루가 이미 말한 텍스트(스트리밍 체감). 미전달 시 이전 값 유지, 뒤 4000자만
        partial: String(partial ?? prev.partial ?? '').slice(-4000),
        // source — 이 상태를 쓴 턴의 출처('room'|'chat'|'delegate'|'routine'…). 크루 상태 파일은 크루당 하나라
        // 같은 크루의 다른 턴(개인 채팅·루틴)이 겹치면 회의실이 남의 문장을 발언으로 오인한다(#393 검수 MEDIUM-2).
        // 미전달이면 이전 값 유지(같은 턴의 후속 갱신), 없으면 빈 값 — 소비자는 빈 값을 '출처 미상'으로 비채택.
        source: source ?? prev.source ?? '',
        // thought — 모델의 사고(thinking 블록) 뒤 1500자. 회의실 발언 카드·1:1 진행 카드의 접이식 "생각"(유건 요청 2026-09-06 (가)).
        // 미전달이면 이전 값 유지(같은 턴의 후속 갱신).
        thought: String(thought ?? prev.thought ?? '').slice(-1500),
        // steps — 단계 궤적(도구 하나 = 단계 하나, chat.mjs step). 메신저 실행 카드가 클로드코드식 드롭다운으로 실시간 표시(유건 요청 2026-09-09). 미전달이면 이전 값 유지.
        steps: Array.isArray(steps) ? steps.slice(-40) : (prev.steps ?? []),
        startedAt: prev.startedAt ?? Date.now(), ts: Date.now(),
      });
    } catch { /* 상태 표시는 베스트에포트 */ }
  });
}

/** 종료 — 심박을 끄고, **진행 중인 쓰기가 끝난 뒤** 파일을 지운다(해제 직후 착지하는 심박이 거짓 '작성 중'을 되살리지 않게). */
export async function clearTurnStatus(wsId, slug) {
  const k = keyOf(wsId, slug);
  const e = live.get(k);
  if (e) { clearInterval(e.timer); live.delete(k); await e.chain.catch(() => {}); }
  try { await rm(file(wsId, slug), { force: true }); } catch { /* 없으면 그만 */ }
}

/** 2분 넘게 갱신이 없으면 죽은 상태로 보고 무시한다. 반환: { stage, detail, partial, startedAt } | null */
export async function getTurnStatus(wsId, slug) {
  try {
    const s = await readJsonLenient(file(wsId, slug), null);
    if (!s || !s.ts) return null;
    return Date.now() - s.ts < 120_000
      ? { stage: s.stage, detail: s.detail ?? '', partial: s.partial ?? '', thought: s.thought ?? '', source: s.source ?? '', steps: Array.isArray(s.steps) ? s.steps : [], startedAt: s.startedAt ?? s.ts }
      : null;
  } catch {
    return null;
  }
}
