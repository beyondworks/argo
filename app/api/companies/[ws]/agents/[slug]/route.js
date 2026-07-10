import { readAgentCard, saveAgentCard, removeAgentCard } from '../../../../../../src/persona.mjs';

/** 카드 열람 — 카드가 곧 시스템 프롬프트(투명성). */
export async function GET(_req, { params }) {
  try {
    const { ws, slug } = await params;
    const { md, meta } = await readAgentCard(ws, slug);
    return Response.json({ md, meta });
  } catch {
    return Response.json({ error: '크루를 찾을 수 없습니다' }, { status: 404 });
  }
}

export async function PUT(req, { params }) {
  try {
    const { ws, slug } = await params;
    const { md } = await req.json();
    if (!md?.trim()) return Response.json({ error: '카드 내용이 필요합니다' }, { status: 400 });
    const agent = await saveAgentCard(ws, slug, md);
    return Response.json({ agent });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 해고 — .archive/로 이동(복구 가능). */
export async function DELETE(_req, { params }) {
  try {
    const { ws, slug } = await params;
    await removeAgentCard(ws, slug);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
