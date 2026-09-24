import { interruptTurn } from '../../../../../../src/turn-abort.mjs';
import { guardCompany } from '../../../../../auth.mjs';

/** 진행 중인 크루 턴 중단 — 사장의 정지 버튼(또는 지금 바로 보내기). 진행 중 턴이 없으면 interrupted:false. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { slug, source } = await req.json();
    if (!slug) return Response.json({ error: 'slug가 필요합니다' }, { status: 400 });
    // "지금 바로 보내기" 표시(viaSendNow)의 서버 저장은 되돌렸다(재검수 4차 MEDIUM 둘 — 표시가
    // 소비 안 되고 남아 며칠 뒤 무관한 정지-중단 턴에 잘못 붙어 영구 저장, 순서 경합). 그 표시는
    // 클라이언트 세션 메모리로만 유지 — 새로고침 뒤 일반 중단 문구로 돌아가는 것은 알려진 한계.
    const interrupted = await interruptTurn(ws, slug, { source: typeof source === 'string' ? source : undefined });
    return Response.json({ interrupted });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
