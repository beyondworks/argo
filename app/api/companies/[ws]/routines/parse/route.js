// 자연어 → 루틴 초안 / 직접 입력 지시문 → 설계 확장(mode:'refine') — 폼 프리필용.
// 실행·저장은 하지 않는다(저장은 기존 POST /routines가 재검증).
import { draftRoutineFromText, refineRoutinePrompt } from '../../../../../../src/routines.mjs';
import { listAgents } from '../../../../../../src/hub.mjs';
import { loadCompany } from '../../../../../../src/workspace.mjs';
import { guardCompany, csrfDenied } from '../../../../../auth.mjs';

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const { text, mode, agentSlug } = await req.json();
    const [agents, { lang = 'ko' }] = await Promise.all([
      listAgents(ws).catch(() => []),
      loadCompany(ws).catch(() => ({})),
    ]);
    if (mode === 'refine') {
      const agent = agents.find((a) => a.slug === agentSlug) ?? null;
      return Response.json(await refineRoutinePrompt(ws, text, { agent, lang }));
    }
    return Response.json(await draftRoutineFromText(ws, text, { agents, lang }));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
