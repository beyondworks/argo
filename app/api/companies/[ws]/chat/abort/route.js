import { interruptTurn } from '../../../../../../src/turn-abort.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 진행 중인 크루 턴 중단 — 사장의 정지 버튼. 진행 중 턴이 없으면 interrupted:false. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug } = await req.json();
    if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
    const interrupted = await interruptTurn(ws, slug);
    return Response.json({ interrupted });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
