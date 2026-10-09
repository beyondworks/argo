import { isStopCommand } from '../../../../../src/stop-command.mjs';
import { interruptTurn } from '../../../../../src/turn-abort.mjs';
import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths, loadCompany } from '../../../../../src/workspace.mjs';
import { threadMtime, loadThread, appendTurn, beginTurn, resetThread, getDelegationLimit } from '../../../../../src/thread.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';
import { pickLiveTrace, traceSummaries } from '../../../../../src/turn-trace.mjs';
import { nudgeSync } from '../../../../../src/sync.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 800; // 호스티드(Vercel Pro) 함수 상한 800 — SDK 턴(상한 없음)이 5분을 넘으면 옛 300은 HTTP가 먼저 죽었다. 로컬·상주·데스크톱은 무관, CLI 러너는 호스티드에서 안 돈다

/** 진행 상태 + 작업 과정 — 화면이 보고 있던 기록(tr)이 살아 있으면 그 기록의 rev 이후 단계만(늘어난 부분), 아니면 상태 파일이 가리키는 기록을 처음부터.
    상태의 옛 steps(최대 40개 요약)는 이 화면이 쓰지 않아 뺀다 — 폴 응답을 줄인다. 같은 크루의 다른 턴과 섞이지 않는 근거는 턴별 기록(turn-trace)이고,
    1:1 화면은 1:1 턴(source 'chat')의 기록만 싣는다 — 같은 크루의 메신저·루틴·회의실 턴 단계는 여기 보이지 않는다. */
function withTrace(ws, slug, status, tr, rev) {
  if (!status) return status;
  const { steps: _legacy, ...rest } = status;
  const live = pickLiveTrace(ws, slug, { want: tr, pointer: status.traceId, source: 'chat' });
  return live ? { ...rest, trace: live.view(live.id === tr ? rev : 0) } : rest;
}

/** 저장된 스레드 로드 — 새로고침해도 대화가 이어진다. */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  // 폴링 dedup — 클라이언트가 마지막으로 받은 mtime을 보내면, 파일이 그대로일 때 본문(수백 KB)을 생략한다.
  // 3초 폴마다 800KB JSON을 직렬화·전송·파싱하던 것이 대화창 버벅임의 한 축이었다(Lean-AX 652건 실측 2026-08-23).
  const known = Number(url.searchParams.get('mtime') || 0);
  const tr = url.searchParams.get('tr') || null;
  const rev = Math.max(0, Number(url.searchParams.get('rev') || 0) || 0);
  const mtime = await threadMtime(ws, slug);
  if (known && mtime && known === mtime) {
    return Response.json({ unchanged: true, mtime, status: withTrace(ws, slug, await getTurnStatus(ws, slug), tr, rev) });
  }
  const [thread, status] = await Promise.all([loadThread(ws, slug), getTurnStatus(ws, slug)]);
  // traces — 이 기기에 저장된 작업 과정 요약({id: {n, ms, ok}}). 다른 기기에서 온 줄의 traceId는 여기 없어 답만 보인다.
  const traces = await traceSummaries(ws, slug, (thread.messages ?? []).map((m) => m.traceId)).catch(() => ({}));
  return Response.json({ ...thread, status: withTrace(ws, slug, status, tr, rev), mtime, traces });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug, message, sessionId, attachments: rawAtt } = await req.json();
    if (!slug || !message?.trim()) {
      return Response.json({ error: 'slug와 message가 필요합니다' }, { status: 400 });
    }
    // 첨부는 업로드 API가 발급한 vault/files/ 상대경로만 신뢰한다(경로 탈출 차단)
    const attachments = (Array.isArray(rawAtt) ? rawAtt : [])
      .filter((a) => typeof a?.rel === 'string' && a.rel.startsWith('files/') && !a.rel.includes('..'))
      .map((a) => ({ rel: a.rel, name: String(a.name ?? ''), mime: String(a.mime ?? ''), isImage: !!a.isImage }))
      .slice(0, 8);
    // 지시를 **먼저** 저장한다 — 답변을 기다리는 동안 새로고침하거나 페이지를 벗어나도 내가 쓴 글이
    // 그대로 남아 있어야 한다(신고 2026-08-02). 저장 실패는 턴을 막지 않는다(대화가 우선).
    const turnId = await beginTurn(ws, slug, { userMsg: message.trim(), attachments })
      .catch((err) => { console.error(`[argo] 지시 선저장 실패(${ws}/${slug}):`, err?.message ?? err); return null; });
    if (turnId) nudgeSync(); // 다른 기기에도 곧바로 보이게
    let t;
    try {
      if (!attachments.length && isStopCommand(message)) {
        const interrupted = await interruptTurn(ws, slug, { source: 'chat' });
        const lang = (await loadCompany(ws)).lang;
        t = { reply: lang === 'en'
          ? (interrupted ? 'Stopping the current execution.' : 'There is no active execution to stop.')
          : (interrupted ? '현재 실행을 중단하고 있습니다.' : '중단할 실행 중인 작업이 없습니다.'), sessionId: sessionId || null };
      } else {
        // 위임 제한 스위치 — 이 대화(스레드)에서 사용자가 푼 상태를 서버가 저장값에서 읽는다(화면이 보내는 값을 믿지 않는다 — 켜짐이 기본이고 fail-closed).
        const relaxed = !(await getDelegationLimit(ws, slug));
        t = await chat(ws, slug, message.trim(), sessionId || null, { attachments, ...(relaxed ? { delegationRelaxed: true } : {}), ...(turnId ? { abortTag: turnId } : {}) }); // abortTag — 바로 보내기(chat/steer)가 정확히 이 턴을 고른다
      }
    } catch (e) {
      // 실패·중단 턴도 스레드에 남긴다 — 성공 뒤에만 저장하면 지시문이 새로고침에 증발하고 비용만
      // 남는다(전수리뷰 2026-07-30 #1). UI는 m.failed로 사유+재전송을 그린다(기존 낙관 사본 패턴).
      // 중단 판정은 **별도 필드(aborted)** — 사유 문자열과 같은 필드에 'aborted' 센티널을 두면
      // 상류 원문이 우연히 그 단어일 때(node:http ECONNRESET의 message='aborted' 실측) "지시대로
      // 중단했습니다"로 원인을 오도한다(재검수 MEDIUM). 사유는 원문 그대로, 표시 문구는 UI가 t()로.
      const failed = String(e?.message || e);
      const aborted = !!e?.aborted;
      const cancellationIncomplete = !!e?.cancellationIncomplete;
      const failedCode = e?.failCode ?? null; // 실패 코드 표(src/runners/error-class.mjs) — UI 행동 안내·통계
      const failedOrigin = e?.failOrigin ?? null; // vendor/argo/probe
      // 저장 성공 여부(saved)를 응답에 싣는다 — 클라 낙관 사본은 saved=false일 때만 폴링 병합에서
      // 캐리오버한다. 안 실으면 서버 보존분과 사본이 라운드마다 복제 누적된다(분리 검수 HIGH 시뮬레이션).
      // 기록 실패는 무증상으로 삼키지 않는다(scheduler·routines와 같은 규칙 — 검수 LOW).
      const traceId = typeof e?.traceId === 'string' ? e.traceId : null; // 실패·중단 턴도 작업 과정을 실패 줄에서 본다(chat()이 오류에 싣는다)
      const saved = await appendTurn(ws, slug, { turnId, traceId, userMsg: message.trim(), failed, failedCode, failedOrigin, aborted, cancellationIncomplete, attachments })
        .then(() => true)
        .catch((err) => { console.error(`[argo] 실패 턴 기록 실패(${ws}/${slug}):`, err?.message ?? err); return false; });
      if (saved) nudgeSync();
      // 작업 과정 요약은 실패 응답에 싣지 않는다 — 턴이 끝난 뒤 첫 폴(전체 다시 받기)이 실패 줄의 traceId와 이 기기 요약(traces)을 함께 가져온다
      return Response.json({ error: failed, code: failedCode, origin: failedOrigin, aborted, cancellationIncomplete, saved }, { status: 500 });
    }
    // handover 없는 턴(예: 예산 초과 안내)도 안전하게 — null 접근 크래시 방지
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    await appendTurn(ws, slug, { turnId, userMsg: message.trim(), reply: t.reply, handover, sessionId: t.sessionId, attachments, steerFailed: t.steerFailed, traceId: t.traceId, artifacts: t.artifacts, fellBack: t.fellBack, modelFallback: t.modelFallback });
    nudgeSync(); // 로컬 변경 즉시 다른 기기로 전파(준실시간 — 다음 대기 건너뜀)
    // 크루 길들이기(리서치 접목 F) — 이 라우트는 **사장 직접 대화의 단일 관문**이다(위임·루틴·쪽지
    // 미경유라 "직접 턴" 판정이 구조로 보장된다). 교정 감지는 fire-and-forget: 응답을 막지 않고,
    // 실패는 로그만(교정은 반복이 전제라 다음 기회에 잡힌다). 프리필터(corrections)가 교정 신호
    // 어휘 없는 턴을 LLM 호출 없이 걸러 비용을 막는다.
    if (!isStopCommand(message)) import('../../../../../src/corrections.mjs')
      .then(async ({ detectAndTrack }) => {
        const lang = (await loadCompany(ws).catch(() => ({}))).lang === 'en' ? 'en' : 'ko';
        return detectAndTrack(ws, { userMsg: message.trim(), lang });
      })
      .catch((e) => console.error(`[argo] 교정 감지 실패(${ws}/${slug}):`, e?.message ?? e));
    const traces = t.traceId ? await traceSummaries(ws, slug, [t.traceId]).catch(() => ({})) : {}; // 방금 끝난 턴의 작업 과정 요약 — 화면이 답 아래 접힌 줄을 바로 그린다
    return Response.json({ reply: t.reply, sessionId: t.sessionId, handover, artifacts: t.artifacts, ...(t.fellBack ? { fellBack: t.fellBack } : {}), ...(t.modelFallback ? { modelFallback: t.modelFallback } : {}), ...(t.steerFailed ? { steerFailed: t.steerFailed } : {}), ...(t.traceId ? { traceId: t.traceId, traces } : {}) }); // 폴백 안내를 그 턴에 즉시(검수 M1 — 폴링 병합이 같은 길이면 서버 사본을 안 받는다)
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}

/** 새 대화 — 스레드·세션 리셋. vault 기억은 유지된다. */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  await resetThread(ws, slug);
  return Response.json({ ok: true });
}
