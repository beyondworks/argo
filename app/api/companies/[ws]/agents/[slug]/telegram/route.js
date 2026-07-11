import { validateConnection, updateAgentBot, maskConnections, gatewayStatus, syncAgentBotName } from '../../../../../../../src/connections.mjs';
import { readAgentCard } from '../../../../../../../src/persona.mjs';
import { ensureGateway } from '../../../../../../../src/gateway.mjs';
import { appendEvent } from '../../../../../../../src/events.mjs';

ensureGateway(); // 연결 즉시 폴러가 뜨도록 매니저 상주

/** 크루 직통 봇 연결 — 저장 전 getMe로 토큰 즉시 검증(연동 안 됨을 저장 시점에 잡는다). */
export async function POST(req, { params }) {
  try {
    const { ws, slug } = await params;
    const { token } = await req.json();
    if (!token?.trim()) return Response.json({ error: '봇 토큰이 필요합니다' }, { status: 400 });
    const botUsername = await validateConnection('telegram', token.trim());
    const all = await updateAgentBot(ws, slug, { token: token.trim(), botUsername });
    await appendEvent(ws, { type: 'gateway', kind: 'telegram', op: 'agent-bot', slug });
    // 봇 표시 이름을 크루 이름으로 — 텔레그램에서 크루 이름 그대로 보이게(베스트에포트)
    readAgentCard(ws, slug).then(({ meta }) => syncAgentBotName(ws, slug, meta.name)).catch(() => {});
    return Response.json({ connections: maskConnections(all), gateway: await gatewayStatus(ws) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 연결 해제 — 토큰 제거(폴러는 매니저 sync가 내린다). */
export async function DELETE(_req, { params }) {
  try {
    const { ws, slug } = await params;
    const all = await updateAgentBot(ws, slug, null);
    return Response.json({ connections: maskConnections(all) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
