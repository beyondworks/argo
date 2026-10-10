import { runRoutine } from '../../../../../../src/routines.mjs';
import { guardCompany, requestLang } from '../../../../../auth.mjs';
import { apiErrorFrom } from '../../../../../apimsg.mjs';

export const maxDuration = 800; // 루틴 = 실제 에이전트 턴 — 호스티드(Vercel Pro) 함수 상한 800(chat 라우트와 같은 값)

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id } = await req.json();
    if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const r = await runRoutine(ws, id);
    return Response.json({ ok: true, reply: r.reply });
  } catch (e) {
    if (e?.errorCode === 'goal_run_now') return apiErrorFrom(e, await requestLang(), 400); // 목표 하트비트는 지금 실행 대상이 아니다
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
