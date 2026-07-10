import { loadCapabilities, updateCapabilities, CAPABILITY_DEFS } from '../../../../../src/capabilities.mjs';

export async function GET(_req, { params }) {
  const { ws } = await params;
  return Response.json({ capabilities: await loadCapabilities(ws), defs: CAPABILITY_DEFS });
}

/** 능력 토글 — 다음 턴부터 즉시 반영(chat이 매 턴 읽는다). */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const capabilities = await updateCapabilities(ws, await req.json());
    return Response.json({ capabilities });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
