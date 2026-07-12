import { runRoutine } from '../../../../../../src/routines.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export const maxDuration = 300; // 루틴 = 실제 에이전트 턴

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id } = await req.json();
    if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const r = await runRoutine(ws, id);
    return Response.json({ ok: true, reply: r.reply });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
