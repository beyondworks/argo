// 보관함(휴지통) — 삭제된 대화를 회사 단위로 모아 보여주고, 복구·영구삭제한다.
// 저장은 chats/.trash/ (삭제=.archive→.trash 이동). 설정 화면 보관함의 백엔드.
import { listTrashedSessions, restoreTrashed, purgeTrashed } from '../../../../../src/thread.mjs';
import { listAgents } from '../../../../../src/hub.mjs';
import { guardCompany, requestLang } from '../../../../auth.mjs';
import { apiError } from '../../../../apimsg.mjs';

/** 보관함 예외 → 응답(2차 검수 M3). 시스템 원문(ENOENT …·절대 경로)을 내리지 않는다: 항목이 없으면(ENOENT·잘못된 id) 404 trash_item_gone, 그 밖은 로그에만 남기고 500 trash_failed. */
async function failure(e, where) {
  const lang = await requestLang();
  if (e?.code === 'ENOENT' || e?.message === '잘못된 세션 id') return apiError('trash_item_gone', lang);
  console.error(`[argo] 보관함 ${where} 실패:`, e?.code ?? '', String(e?.message ?? e).slice(0, 200));
  return apiError('trash_failed', lang);
}

/** 보관함 목록 — 크루 이름을 붙여 반환(회사 전체). */
export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    const [items, agents] = await Promise.all([listTrashedSessions(ws), listAgents(ws).catch(() => [])]);
    const nameOf = (slug) => agents.find((a) => a.slug === slug)?.name ?? slug;
    return Response.json({ items: items.map((it) => ({ ...it, crew: nameOf(it.slug) })) });
  } catch (e) {
    return failure(e, '목록');
  }
}

/** 복구 — 보관함 → 크루 세션 레일로 되돌린다. body: { id } */
export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { id } = await req.json().catch(() => ({}));
  if (!id) return apiError('trash_bad_request', await requestLang());
  try {
    return Response.json(await restoreTrashed(ws, id));
  } catch (e) {
    return failure(e, '복구');
  }
}

/** 영구 삭제 — 보관함에서 완전히 제거(복구 불가). query: ?id= */
export async function DELETE(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('trash_bad_request', await requestLang());
  try {
    return Response.json(await purgeTrashed(ws, id));
  } catch (e) {
    return failure(e, '영구 삭제');
  }
}
