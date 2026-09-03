// 휴대폰 연결 관리 — PC 설정 카드("휴대폰에서 열기") 전용.
// 3중 계약(기기 링크·게스트와 동일): 루프백 한정 + CSRF + 이 PC의 신원. 워커(TENANT)는 없음.
//   GET    상태(토글·포트·주소 후보·연결된 폰·발급 중 코드·리스너 실상태)
//   PUT    { enabled, port? } — 켜면 같은 프로세스의 LAN 리스너를 시작하고 코드를 발급, 끄면 리스너 정지
//   POST   새 코드 발급   DELETE { id } 연결 해제
// 리스너의 업스트림 포트는 PORT env(next start -p·Tauri 사이드카 모두 기동 시 박는다, start-server.js:302)가
// 1순위, 없으면 이 요청의 Host 포트(=Next 서버 자신 — 루프백 한정 라우트라 리스너 경유 위조 불가).
import { networkInterfaces } from 'node:os';
import { authError, csrfDenied, currentUser, isLoopbackHost, requestLang } from '../../auth.mjs';
import { apiError } from '../../apimsg.mjs';
import { codeAlive, loadMobile, newPairCode, publicView, revokePair, setMobileEnabled } from '../../../src/mobile-pairs.mjs';
import { mobileListenerStatus, startMobileListener, stopMobileListener } from '../../../src/mobile-listener.mjs';

async function gate(req) {
  const lang = await requestLang();
  if (process.env.ARGO_TENANT_OWNER?.trim() || !isLoopbackHost(req.headers.get('host'))) return apiError('mobile_loopback_only', lang);
  if (!(await currentUser())) return authError('auth_required', lang);
  return null;
}
const hostPort = (req) => Number(process.env.PORT) || Number((req.headers.get('host') || '').match(/:(\d+)$/)?.[1]) || 80;
// 폰이 닿을 수 있는 이 PC의 주소 후보 — 비내부 IPv4. Tailscale(100.64/10)은 표시용 플래그.
export const lanAddresses = () => Object.entries(networkInterfaces()).flatMap(([iface, list]) =>
  (list || []).filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => ({ ip: a.address, iface, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) })));

async function view() {
  return Response.json({ ...publicView(await loadMobile()), listener: mobileListenerStatus(), addresses: lanAddresses() });
}

export async function GET(req) {
  const g = await gate(req); if (g) return g;
  return view();
}

export async function PUT(req) {
  const csrf = csrfDenied(req); if (csrf) return csrf;
  const g = await gate(req); if (g) return g;
  const { enabled, port } = await req.json();
  if (enabled) {
    const cur = await loadMobile();
    const upstreamPort = hostPort(req);
    let cfg;
    try {
      cfg = await startMobileListener({ port: Number.isInteger(port) && port >= 0 ? port : cur.port, upstreamPort }); // 0 = OS 배정(테스트·충돌 회피), 미지정 = 저장값
    } catch (e) {
      if (e.code === 'EADDRINUSE' || e.code === 'EACCES') return apiError('mobile_port_busy', await requestLang());
      throw e;
    }
    const m = await setMobileEnabled(true, { port: cfg.port, upstreamPort });
    if (!codeAlive(m.pending)) await newPairCode();
  } else {
    await stopMobileListener();
    await setMobileEnabled(false);
  }
  return view();
}

export async function POST(req) {
  const csrf = csrfDenied(req); if (csrf) return csrf;
  const g = await gate(req); if (g) return g;
  const { code, exp } = await newPairCode();
  return Response.json({ code, exp });
}

export async function DELETE(req) {
  const csrf = csrfDenied(req); if (csrf) return csrf;
  const g = await gate(req); if (g) return g;
  const { id } = await req.json();
  if (!(await revokePair(String(id || '')))) return apiError('mobile_pair_not_found', await requestLang());
  return Response.json({ ok: true });
}
