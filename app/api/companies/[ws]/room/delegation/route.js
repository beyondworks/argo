import { setRoomDelegationLimit } from '../../../../../../src/room.mjs';
import { nudgeSync } from '../../../../../../src/sync.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 회의실의 위임 제한 스위치 — { limit } (true = 켜짐(기본), false = 푼 상태). 현재 회의에만 적용된다(마치기·새 회의는 켜짐으로 시작).
    값은 방 파일에 저장돼 GET /room 응답(delegationLimit)으로 화면에 돌아오고, 다음 회의 턴이 저장값을 직접 읽는다. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { limit } = await req.json();
    if (typeof limit !== 'boolean') return Response.json({ error: 'limit(true/false)가 필요합니다' }, { status: 400 });
    const r = await setRoomDelegationLimit(ws, limit);
    nudgeSync();
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
