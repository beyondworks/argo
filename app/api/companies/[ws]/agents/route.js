import { createAgentFromPrompt, renameTeam } from '../../../../../src/persona.mjs';
import { listAgents } from '../../../../../src/hub.mjs';

/** 팀 이름 일괄 변경. */
export async function PATCH(req, { params }) {
  try {
    const { ws } = await params;
    const { from, to } = await req.json();
    if (!from || !to?.trim()) return Response.json({ error: 'from·to가 필요합니다' }, { status: 400 });
    const r = await renameTeam(ws, from, to);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

export const maxDuration = 120; // 페르소나 카드 생성은 모델 1턴 — 수십 초 걸릴 수 있다

export async function GET(_req, { params }) {
  const { ws } = await params;
  return Response.json({ agents: await listAgents(ws) });
}

export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const { prompt, name, team } = await req.json();
    if (!prompt?.trim()) return Response.json({ error: '한 줄 소개가 필요합니다' }, { status: 400 });
    const agent = await createAgentFromPrompt(ws, prompt.trim(), { name, team });
    // 영입 시운전 — 백그라운드로 첫 인사+샘플 산출물을 만들어 채팅 첫 화면을 채운다
    import('../../../../../src/trial.mjs').then((m) => m.runTrialTurn(ws, agent.slug)).catch(() => {});
    return Response.json({ agent });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
