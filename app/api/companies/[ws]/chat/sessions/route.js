import { listArchivedSessions, readArchivedSession, resumeSession, renameSession, renameActiveThread, trashSession, setPinned } from '../../../../../../src/thread.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 세션 적재 레일 — 목록(slug) 또는 보관 세션 1건(slug+id, 읽기 전용). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  const id = url.searchParams.get('id');
  try {
    if (id) return Response.json(await readArchivedSession(ws, slug, id));
    return Response.json({ sessions: await listArchivedSessions(ws, slug) });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 대화 이어가기 — 보관 세션을 활성 스레드로 되살린다(현재 대화는 자동 보관). body: { slug, id } */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { slug, id } = await req.json().catch(() => ({}));
  if (!slug || !id) return Response.json({ error: 'slug·id가 필요합니다' }, { status: 400 });
  try {
    const thread = await resumeSession(ws, slug, id);
    return Response.json({ thread });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 대화명 편집 또는 고정 토글 — 보관 세션에 title/pinned 기록. body: { slug, id, title } | { slug, id, pinned } */
export async function PATCH(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { slug, id, title, pinned } = await req.json().catch(() => ({}));
  if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
  try {
    // id 없음 = 현재(활성) 대화 — 이름 편집만 지원(핀은 보관 대화 표식이라 활성엔 무의미)
    if (!id) {
      if (pinned !== undefined) return Response.json({ error: '현재 대화는 고정할 수 없습니다' }, { status: 400 });
      return Response.json(await renameActiveThread(ws, slug, title));
    }
    // pinned가 오면 고정 토글, 아니면 대화명 편집(둘은 배타 — 한 요청에 하나만)
    if (pinned !== undefined) return Response.json(await setPinned(ws, slug, id, pinned === true));
    return Response.json(await renameSession(ws, slug, id, title));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}

/** 세션 삭제(보관) — .archive → .trash 이동(설정 보관함에서 복구 가능). query: ?slug=&id= */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug');
  const id = url.searchParams.get('id');
  if (!slug || !id) return Response.json({ error: 'slug·id가 필요합니다' }, { status: 400 });
  try {
    return Response.json(await trashSession(ws, slug, id));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
