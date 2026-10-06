import { sendSessionMessage } from '../../../../../src/session-msg.mjs';
import { nudgeSync } from '../../../../../src/sync.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 세션 메시지 보내기 — 1:1 채팅방(room 크루)의 입력창에서 사장이 `@B 내용`을 보냈다.
    room 크루의 턴은 만들지 않는다(A 턴 0번). B가 이어 가던 세션에 출처가 붙은 글로 들어가고, B의 답은 room 방에 카드로 돌아온다.
    응답 line = room 방에 남긴 보낸 줄(화면이 바로 붙인다). 실패는 code(DUP·NOT_FOUND·SELF·EMPTY·TOO_LONG…)로 — 화면이 사전 문구로 그린다. */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  let body = {};
  try { body = await req.json(); } catch { /* 빈 본문 — 아래 검증이 막는다 */ }
  const { room, to, message } = body ?? {};
  if (typeof room !== 'string' || typeof to !== 'string' || typeof message !== 'string') {
    return Response.json({ error: 'room·to·message가 필요합니다', code: 'BAD_REQUEST' }, { status: 400 });
  }
  try {
    const r = await sendSessionMessage(ws, { room, sender: 'captain', to, message });
    nudgeSync(); // 보낸 줄·B 방의 대기 줄을 다른 기기에도 곧바로
    return Response.json({ ok: true, id: r.id, line: r.line });
  } catch (e) {
    const code = e?.code ?? null;
    return Response.json({ error: String(e?.message || e), code }, { status: code ? (code === 'DUP' ? 409 : 400) : 500 });
  }
}
