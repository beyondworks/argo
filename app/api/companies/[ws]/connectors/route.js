// 커넥터 API — 로그인만으로 붙는 외부 서비스(설계서 US-6). 설정 화면 전용.
// 목록은 카탈로그 × 이 회사 연결 상태를 병합해 내려주고, 연결은 브라우저 동의 URL을 돌려준다.
// 자격(토큰·client secret)은 listConnections가 애초에 걸러 오므로 이 라우트를 통해 새지 않는다.
import { connectorCatalogFor, connectConnector, mergeConnectorStatus } from '../../../../../src/market.mjs';
import { guardCompany, csrfDenied } from '../../../../auth.mjs';

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { listConnections } = await import('../../../../../src/connectors.mjs');
  // 표시 언어 — 화면이 보내는 UI 언어(?lang)가 1순위다. 카드의 나머지 문구는 전부 t()(UI 언어)를
  // 따르므로 name·note만 회사 언어로 내리면 카드 한 장에 두 언어가 섞인다(실측 2026-08-29:
  // en 모드에 "구글 캘린더" 잔존). 쿼리가 없거나 무효면 기존대로 회사 시스템 언어로 폴백.
  const q = new URL(req.url).searchParams.get('lang');
  let lang = q === 'en' || q === 'ko' ? q : null;
  if (!lang) {
    const { loadCompany } = await import('../../../../../src/workspace.mjs');
    lang = (await loadCompany(ws).catch(() => null))?.lang === 'en' ? 'en' : 'ko';
  }
  const rows = mergeConnectorStatus(connectorCatalogFor(lang), await listConnections(ws).catch(() => []));
  return Response.json({ connectors: rows });
}

/** 연결/해제. 연결은 **동의 URL만** 돌려준다 — 인가 완료를 기다리면 사용자가 브라우저에서 로그인하는
    동안 응답이 그만큼 막힌다. 완료는 화면이 목록을 다시 읽어 상태로 관측한다(코어와 같은 계약). */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    // CSRF — 외부 서비스에 이 회사를 붙이는 상태변경이다(workroots 라우트와 같은 계열).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { id, action } = await req.json();
    if (typeof id !== 'string' || !id.trim()) return Response.json({ error: 'id가 필요합니다' }, { status: 400 });
    const { loadCompany } = await import('../../../../../src/workspace.mjs');
    const lang = (await loadCompany(ws).catch(() => null))?.lang === 'en' ? 'en' : 'ko';
    if (action === 'disconnect') {
      const { disconnectConnector } = await import('../../../../../src/connectors.mjs');
      await disconnectConnector(ws, id);
      return Response.json({ ok: true });
    }
    const { authUrl } = await connectConnector(ws, id, { lang });
    return Response.json({ ok: true, authUrl });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
