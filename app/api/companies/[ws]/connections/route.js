import { loadConnections, updateConnection, maskConnections, validateConnection, gatewayStatus } from '../../../../../src/connections.mjs';
import { ensureGateway } from '../../../../../src/gateway.mjs';
import { syncStatus } from '../../../../../src/sync.mjs';
import { guardCompany } from '../../../../auth.mjs';

ensureGateway();

/** 연결 상태 — 토큰은 항상 마스킹, 게이트웨이 폴러 하트비트 동봉("연동 안 됨"을 화면에서 진단). */
export async function GET(_req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const [all, gateway] = await Promise.all([loadConnections(ws), gatewayStatus(ws)]);
  return Response.json({ connections: maskConnections(all), gateway, sync: syncStatus() });
}

/** 연결 설정 — { kind: 'telegram'|'slack', token?, enabled?, defaultCrew?, channel?, mutedEvents? }. 빈 token은 기존 유지.
    mutedEvents만 보내면 토큰 재검증 없이 알림 선택만 바뀐다(enabled 미포함 → 검증 분기 미진입).
    가동(enabled) 시 토큰을 즉시 검증해 봇 이름을 저장한다 — 잘못된 토큰은 저장 전에 걸러진다. */
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await guardCompany(ws); if (denied) return denied;
    const { kind, ...patch } = await req.json();
    const allowed = {};
    for (const k of ['token', 'enabled', 'defaultCrew', 'channel', 'mutedEvents']) {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    }
    if (allowed.enabled) {
      const cur = (await loadConnections(ws))[kind];
      const token = allowed.token?.trim() || cur.token;
      if (!token) throw new Error('봇 토큰이 필요합니다');
      allowed.botUsername = await validateConnection(kind, token);
    }
    const all = await updateConnection(ws, kind, allowed);
    // gateway 상태는 폴러를 켜고 끄는 패치일 때만 계산한다 — 알림 선택만 바꾸는 호출(mutedEvents)은
    // 폴러와 무관하고, gatewayStatus는 연결 재로딩 + 채널·크루봇 수만큼 파일을 더 읽는다. 화면은
    // 8초 하트비트 GET으로 이미 받고 있다(정리 검수: 이 응답의 gateway를 읽는 호출자가 없다).
    const touchesGateway = ['enabled', 'token', 'channel'].some((k) => allowed[k] !== undefined);
    return Response.json({
      connections: maskConnections(all),
      ...(touchesGateway ? { gateway: await gatewayStatus(ws) } : {}),
    });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
