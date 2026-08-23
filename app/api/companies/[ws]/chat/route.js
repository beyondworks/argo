import { relative } from 'node:path';
import { chat } from '../../../../../src/chat.mjs';
import { paths } from '../../../../../src/workspace.mjs';
import { threadMtime, loadThread, appendTurn, beginTurn, resetThread } from '../../../../../src/thread.mjs';
import { getTurnStatus } from '../../../../../src/turn-status.mjs';
import { nudgeSync } from '../../../../../src/sync.mjs';
import { guardCompany } from '../../../../auth.mjs';

export const maxDuration = 300; // 에이전트 턴은 vault 탐색 포함 수 분까지 허용

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
  const mtime = await threadMtime(ws, slug);
  if (known && mtime && known === mtime) {
    return Response.json({ unchanged: true, mtime, status: await getTurnStatus(ws, slug) });
  }
  const [thread, status] = await Promise.all([loadThread(ws, slug), getTurnStatus(ws, slug)]);
  return Response.json({ ...thread, status, mtime });
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
      t = await chat(ws, slug, message.trim(), sessionId || null, { attachments });
    } catch (e) {
      // 실패·중단 턴도 스레드에 남긴다 — 성공 뒤에만 저장하면 지시문이 새로고침에 증발하고 비용만
      // 남는다(전수리뷰 2026-07-30 #1). UI는 m.failed로 사유+재전송을 그린다(기존 낙관 사본 패턴).
      // 중단 판정은 **별도 필드(aborted)** — 사유 문자열과 같은 필드에 'aborted' 센티널을 두면
      // 상류 원문이 우연히 그 단어일 때(node:http ECONNRESET의 message='aborted' 실측) "지시대로
      // 중단했습니다"로 원인을 오도한다(재검수 MEDIUM). 사유는 원문 그대로, 표시 문구는 UI가 t()로.
      const failed = String(e?.message || e);
      const aborted = !!e?.aborted;
      // 저장 성공 여부(saved)를 응답에 싣는다 — 클라 낙관 사본은 saved=false일 때만 폴링 병합에서
      // 캐리오버한다. 안 실으면 서버 보존분과 사본이 라운드마다 복제 누적된다(분리 검수 HIGH 시뮬레이션).
      // 기록 실패는 무증상으로 삼키지 않는다(scheduler·routines와 같은 규칙 — 검수 LOW).
      const saved = await appendTurn(ws, slug, { turnId, userMsg: message.trim(), failed, aborted, attachments })
        .then(() => true)
        .catch((err) => { console.error(`[argo] 실패 턴 기록 실패(${ws}/${slug}):`, err?.message ?? err); return false; });
      if (saved) nudgeSync();
      return Response.json({ error: failed, aborted, saved }, { status: 500 });
    }
    // handover 없는 턴(예: 예산 초과 안내)도 안전하게 — null 접근 크래시 방지
    const handover = t.handover ? { rel: relative(paths(ws).vault, t.handover.file), linked: t.handover.linked } : null;
    await appendTurn(ws, slug, { turnId, userMsg: message.trim(), reply: t.reply, handover, sessionId: t.sessionId, attachments, artifacts: t.artifacts });
    nudgeSync(); // 로컬 변경 즉시 다른 기기로 전파(준실시간 — 다음 대기 건너뜀)
    return Response.json({ reply: t.reply, sessionId: t.sessionId, handover, artifacts: t.artifacts });
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
