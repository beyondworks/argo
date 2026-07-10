import { readAgentCard, saveAgentCard, removeAgentCard, updateAgentMeta } from '../../../../../../src/persona.mjs';

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

/** 신원 수정 — 이름·역할·팀만 갱신(카드 본문·슬러그·기록 보존). */
export async function PATCH(req, { params }) {
  try {
    const { ws, slug } = await params;
    const { name, role, team } = await req.json();
    const meta = await updateAgentMeta(ws, slug, { name, role, team });
    return Response.json({ meta });
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
