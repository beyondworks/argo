// 목표 하트비트 목록·상태 바꾸기(루틴 화면 "내 하트비트 → 목표 하트비트") — 엔진은 src/goal-heartbeat.mjs. 만들기는 에이전트가 한다(goal_heartbeat 도구 — 화면에는 만들기 칸이 없다).
import { goalsForScreen, setGoalState } from '../../../../../src/goal-heartbeat.mjs';
import { guardCompany, requestLang } from '../../../../auth.mjs';
import { apiErrorFrom } from '../../../../apimsg.mjs';
import { codedError } from '../../../../../src/coded-error.mjs';

const MSG = {
  goal_not_found: '목표 하트비트를 찾을 수 없습니다',
  goal_ended: '이미 끝난 목표입니다',
  goal_max_active: '목표 하트비트는 동시에 5개까지 켤 수 있습니다',
  goal_deadline_past: '기한이 지난 목표는 다시 켤 수 없습니다',
  goal_op_invalid: '알 수 없는 동작입니다',
};

export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json({ goals: await goalsForScreen(ws) });
  } catch (e) {
    return Response.json({ error: String(e.message || e), code: 'ROUTINES_CORRUPT' }, { status: 500 }); // 손상 — 빈 목록으로 붕괴시키지 않는다(루틴 목록과 같다)
  }
}

export async function POST(req, { params }) { // 화면 api()가 POST만 쓴다 — 동작은 op(pause·resume·stop)
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, op } = await req.json();
    if (!['pause', 'resume', 'stop'].includes(op)) throw codedError('goal_op_invalid', MSG.goal_op_invalid);
    const r = await setGoalState(ws, String(id ?? ''), op);
    if (!r.ok) throw codedError(r.code, MSG[r.code] ?? MSG.goal_not_found);
    return Response.json({ ok: true, goals: await goalsForScreen(ws) });
  } catch (e) {
    return apiErrorFrom(e, await requestLang(), 400);
  }
}
