import { createAgentFromPrompt } from '../../../../../src/persona.mjs';
import { listAgents } from '../../../../../src/hub.mjs';

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
    return Response.json({ agent });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
