import { setDelegationLimit } from '../../../../../../src/thread.mjs';
import { listAgents } from '../../../../../../src/hub.mjs';
import { nudgeSync } from '../../../../../../src/sync.mjs';
import { guardCompany, requestLang } from '../../../../../auth.mjs';
import { apiError } from '../../../../../apimsg.mjs';

/** 1:1 대화의 위임 제한 스위치 — { slug, limit } (limit true = 켜짐(기본), false = 푼 상태). 값은 그 크루의 활성 스레드 파일에 저장돼
    GET /chat 응답(delegationLimit)으로 화면에 돌아온다. 턴이 읽는 곳은 chat 라우트 POST(저장값을 직접 읽는다). */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug, limit } = await req.json();
    if (!slug || typeof limit !== 'boolean') return Response.json({ error: 'slug와 limit(true/false)가 필요합니다' }, { status: 400 });
    // 없는 크루 이름으로 빈 스레드 파일이 생기지 않게(slug는 곧 파일 이름)
    if (!(await listAgents(ws)).some((a) => a.slug === slug)) return apiError('crew_card_not_found', await requestLang());
    const r = await setDelegationLimit(ws, slug, limit);
    nudgeSync(); // 다른 기기에도 곧 같은 값으로
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
