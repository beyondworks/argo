// 보관함(휴지통) — 삭제된 대화를 회사 단위로 모아 보여주고, 복구·영구삭제한다.
// 저장은 chats/.trash/ (삭제=.archive→.trash 이동). 설정 화면 보관함의 백엔드.
import { listTrashedSessions, restoreTrashed, purgeTrashed } from '../../../../../src/thread.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { guardCompany } from '../../../../auth.mjs';

/** 보관함 목록 — 크루 이름을 붙여 반환(회사 전체). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    const [items, agents] = await Promise.all([listTrashedSessions(ws), listAgents(ws).catch(() => [])]);
    const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;
    return Response.json({ items: items.map((it) => ({ ...it, crew: nameOf(it.slug) })) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 복구 — 보관함 → 크루 세션 레일로 되돌린다. body: { id } */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { id } = await req.json().catch(() => ({}));
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  try {
    return Response.json(await restoreTrashed(ws, id));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 영구 삭제 — 보관함에서 완전히 제거(복구 불가). query: ?id= */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
  try {
    return Response.json(await purgeTrashed(ws, id));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
