import { interruptTurn, markAbortReason } from '../../../../../../src/turn-abort.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 진행 중인 크루 턴 중단 — 사장의 정지 버튼(또는 지금 바로 보내기). 진행 중 턴이 없으면 interrupted:false. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug, source, reason } = await req.json();
    if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
    // reason='sendNow' — 원래 턴의 POST /chat(별개 요청)이 실패 응답을 만들 때 이 표시를 읽어
    // viaSendNow로 저장한다(재검수 D). 중단이 실제로 안 먹혔으면(interrupted:false) 표시를 남기지
    // 않는다 — 무관한 다음 실패가 잘못 태깅되면 안 된다.
    const interrupted = await interruptTurn(ws, slug, { source: typeof source === 'string' ? source : undefined });
    if (interrupted && reason === 'sendNow') markAbortReason(ws, slug, 'sendNow');
    return Response.json({ interrupted });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
