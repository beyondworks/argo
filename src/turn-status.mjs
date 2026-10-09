// 턴 진행 단계 — "작성중" 한 마디로 뭉개지 않는다(Hermes 교훈: 지연과 먹통을 구분 못 하면 신뢰 붕괴).
// chat이 단계를 파일로 남기고, 크루 화면이 폴링해 보여준다.
import { rm } from 'node:fs/promises';
import { sanitizeFileSlug } from './slug.mjs';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { maskSecrets } from './secret-mask.mjs';

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
/* 요약은 **가린 뒤에 자른다** — 상태 파일과 활동 이벤트(events.jsonl: 기기 간 동기화·클라우드 저장소)에 실리는 값이라, 자른 원문을 가리면
   경계에 걸린 토큰의 앞 몇 글자가 남는다(0.1.99 이하: 명령 앞 48자 원문). 원문 **전체**를 가린 뒤 48·120자로 자른다.
   가림은 입력 길이에 선형이지만(secret-mask.mjs) 한 번의 도구 호출이 수 MB일 때를 막으려 64KB를 상한으로 둔다 — 모델 한 번의 출력은 그 안에 든다.
   상한을 넘은 입력은 가린 결과의 **끝 8KB를 버린다**: 자른 자리에 걸린 비밀은 규칙이 끝까지 못 보고 조각으로 남을 수 있고(예: `://사용자:비밀번호`가
   `@` 앞에서 잘림), 앞쪽 큰 비밀이 `***`로 줄어들면 그 조각이 앞 48자 안으로 당겨질 수 있다. 끝을 버리면 그 조각은 출력에 닿지 않는다. */
const DETAIL_MASK_CAP = 65_536;
const DETAIL_MASK_TAIL_DROP = 8192;
const masked = (v) => {
  const s = String(v ?? '');
  if (s.length <= DETAIL_MASK_CAP) return maskSecrets(s);
  const m = maskSecrets(s.slice(0, DETAIL_MASK_CAP));
  return m.slice(0, Math.max(0, m.length - DETAIL_MASK_TAIL_DROP));
};
/** 도구 입력에서 "무엇을" 하는지 한 조각 — 클로드코드의 도구 라벨처럼. 비밀은 가린 값만 돌려준다. */
export function detailForTool(toolName, input = {}, { display = false } = {}) {
  try {
    if (/^(Read|Write|Edit|NotebookEdit)$/.test(toolName)) return masked(base(input.file_path));
    if (toolName === 'Glob' || toolName === 'Grep') return masked(input.pattern);
    if (toolName === 'Bash') {
      const description = display && typeof input.description === 'string' ? input.description.trim() : '';
      return masked(description || input.command || '').replace(/\s+/g, ' ').slice(0, description ? 120 : 48);
    }
    if (toolName === 'WebFetch') return new URL(input.url).hostname;
    if (toolName === 'WebSearch') return masked(input.query).slice(0, 48);
    if (toolName === 'mcp__crew__delegate') return masked(input.to);
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
/* 상태 파일 소유 — 앱 사이드카와 argo CLI가 같은 폴더를 쓰면 두 프로세스의 턴이 크루당 하나뿐인 이 파일을 같이 쓰고 지운다(반대 검토 M-b ②).
   turnGroups는 이 프로세스의 등록부라 다른 프로세스의 턴을 모른다 — 그래서 파일에 쓴 프로세스의 pid를 남기고, **다른 살아 있는 프로세스가 쓴 신선한 파일**은
   지우지도(clear) 갱신하지도(심박) 않으며 그 내용(partial·steps)을 이어받지도 않는다. pid 없는 옛 파일·죽은 pid·낡은 파일은 종전대로 내 것으로 본다. */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
const foreign = (s) => !!s?.pid && s.pid !== process.pid && !!s.ts && Date.now() - s.ts < 120_000 && pidAlive(s.pid);
async function touch(wsId, slug) {
  const s = await readJsonLenient(file(wsId, slug), null);
  if (!s || !s.ts) return; // 지워졌거나 아직 없음 — 되살리지 않는다
  if (foreign(s)) return; // 다른 프로세스의 턴이 쓴 파일 — 그 프로세스가 자기 심박으로 갱신한다
  await writeJsonAtomic(file(wsId, slug), { ...s, ts: Date.now() });
}

export async function setTurnStatus(wsId, slug, stage, detail = '', partial, source, thought, steps) {
  const k = keyOf(wsId, slug);
  let e = live.get(k);
  if (!e) {
    e = { chain: Promise.resolve(), timer: null, queued: false };
    live.set(k, e);
    e.timer = setInterval(() => {
      if (e.deferred && !turnGroups(wsId, slug)) { clearTurnStatus(wsId, slug).catch(() => {}); return; } // 서로 미룬 채 모두 끝남(K51 경합)
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
      const prev = prev0?.ts && Date.now() - prev0.ts < 120_000 && !foreign(prev0) ? prev0 : {}; // 120초 = getTurnStatus의 만료 창과 같은 값 — 심박(30초)이 이 창을 덮어야 정상 턴이 잔재로 오인되지 않는다(HEARTBEAT_MS ≪ 120초 결합)
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
        startedAt: prev.startedAt ?? Date.now(), ts: Date.now(), pid: process.pid,
      });
    } catch { /* 상태 표시는 베스트에포트 */ }
  });
}

/* 같은 크루의 살아 있는 논리 턴 수 — turn-abort 등록부(globalThis 공유, 논리 턴 = group)를 읽는다. 상태 파일·심박은 크루당 하나라
   먼저 끝난 턴(1:1)이 지우면 아직 도는 턴(루틴·위임 수신)의 진행 표시·심박이 사라졌다(K51). 호출자(chat.mjs)는 제 턴이 등록된 채
   clear한다(withTurnControl이 runChat 전체를 감싼다) → 2 이상이면 다른 턴이 남아 있다. 등록 없는 호출(회의실 마커)은 0 — 종전대로. */
const turnGroups = (wsId, slug) => new Set([...(globalThis.__argoTurnAbort?.get(`${wsId}:${slug}`) ?? [])].map((x) => x.group)).size;

/** 종료 — 심박을 끄고, **진행 중인 쓰기가 끝난 뒤** 파일을 지운다(해제 직후 착지하는 심박이 거짓 '작성 중'을 되살리지 않게).
    같은 크루의 다른 턴이 아직 돌면 미룬다 — 마지막 턴의 clear가 지우고, 서로 미룬 채 모두 끝나면 심박이 치운다. */
export async function clearTurnStatus(wsId, slug) {
  const k = keyOf(wsId, slug);
  const e = live.get(k);
  if (turnGroups(wsId, slug) > 1) { if (e) e.deferred = true; return; }
  if (e) { clearInterval(e.timer); live.delete(k); await e.chain.catch(() => {}); }
  try {
    if (foreign(await readJsonLenient(file(wsId, slug), null))) return; // 다른 프로세스의 진행 중 턴 표시 — 지우면 그 턴의 "작성 중"이 사라진다
    await rm(file(wsId, slug), { force: true });
  } catch { /* 없으면 그만 */ }
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
