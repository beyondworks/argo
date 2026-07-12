import { readEvents } from '../../../../../src/events.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 활동 — 이벤트 저널(턴·기억·결재·크루·페어링). 화면이 필터링하기 좋게 원본 그대로 최신순. */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  return Response.json({ events: await readEvents(ws, 150) });
}
