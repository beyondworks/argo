import { loadRoom, runRoomTurn, endMeeting, getRoomTurn } from '../../../../../src/room.mjs';
import { guardCompany, requestLang } from '../../../../auth.mjs';

export const maxDuration = 300; // 여러 크루가 순차 발언 — 오래 걸릴 수 있다

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  // turn — 진행 중 마커(화면이 페이지 복귀 때 '회의 중' 표시를 복원). 없으면 null.
  const [room, turn] = await Promise.all([loadRoom(ws), getRoomTurn(ws)]);
  return Response.json({ ...room, turn });
}

/** 회의 마치기 — 회의록을 vault 일지로 적재하고 방을 비운다(대화는 chats/.archive/에 보관).
    크루가 발언 중이면 409 ROOM_BUSY(errorCode 동봉 — 화면이 표시 언어 안내로 그린다). */
export async function DELETE(_req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    // 진행 중 턴이 있으면 거절(409) — 마치기가 도는 발언을 가로지르면 남은 발언이 방·개인 스레드 어디에도 남지 않는다.
    // 화면 잠금(disabled)만으로는 얇다: 다른 탭·직접 호출·잠금이 풀리는 창(#393 검수 MEDIUM-1)이 있다. 서버가 최종 게이트.
    if ((await getRoomTurn(ws))?.active) {
      const en = (await requestLang()) === 'en';
      return Response.json({ error: en ? 'A crew is still speaking — end the meeting after it finishes.' : '발언이 진행 중입니다 — 끝난 뒤 회의를 마쳐 주세요.' }, { status: 409 });
    }
    return Response.json(await endMeeting(ws));
  } catch (e) {
    return Response.json({ error: String(e.message || e), errorCode: e?.code }, { status: e?.code === 'ROOM_BUSY' ? 409 : 400 });
  }
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { message, attachments: rawAtt } = await req.json();
    if (!message?.trim()) return Response.json({ error: 'message가 필요합니다' }, { status: 400 });
    // 첨부는 업로드 API가 발급한 vault/files/ 상대경로만 신뢰한다(경로 탈출 차단 — chat 라우트와 동일 규칙)
    const attachments = (Array.isArray(rawAtt) ? rawAtt : [])
      .filter((a) => typeof a?.rel === 'string' && a.rel.startsWith('files/') && !a.rel.includes('..'))
      .map((a) => ({ rel: a.rel, name: String(a.name ?? ''), mime: String(a.mime ?? ''), isImage: !!a.isImage }))
      .slice(0, 8);
    return Response.json(await runRoomTurn(ws, message.trim(), attachments));
  } catch (e) {
    // saved — 안건이 방에 저장된 뒤의 실패인지(runRoomTurn 표식). 화면은 미저장일 때만 입력을 되돌린다(chat 라우트 계약과 동형).
    return Response.json({ error: String(e.message || e), saved: e?.saved === true }, { status: 500 });
  }
}
