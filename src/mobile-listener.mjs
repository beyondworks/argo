// LAN 리스너 — 같은 프로세스 안에서 0.0.0.0:<port>를 열고 127.0.0.1:<upstreamPort>(Next 서버 자신)로 그대로
// 넘기는 프록시. 데스크톱·상주·셀프호스트의 127.0.0.1 바인딩 정책은 바꾸지 않는다 — 설정 토글로 이
// 리스너만 켜고 끈다(재시작·plist·src-tauri 무관). Host 헤더를 보존하므로 미들웨어가 "비루프백 + argo-mobile
// 쿠키"로 폰 요청을 분간한다(src/mobile-pairs.mjs). 토글 off = 이 파일은 아무것도 열지 않는다.
// ponytail: WebSocket 미지원 — 앱에 WS·SSE가 0건(전부 폴링)이라 필요 없다. 필요해지면 'upgrade' 핸들러 추가.
import http from 'node:http';

// globalThis 가드 — Next는 라우트 청크와 instrumentation이 모듈 인스턴스를 따로 가질 수 있다(ensure* 관례).
const G = globalThis;
const state = () => (G.__argoMobileListener ??= { server: null, cfg: null });

export function mobileListenerStatus() {
  const s = state();
  return s.server ? { listening: true, ...s.cfg } : { listening: false };
}

/** 리스너 시작(같은 설정이면 무동작·다른 설정이면 교체). port 0 = OS 배정(테스트). 반환 { port, upstreamPort }. */
export async function startMobileListener({ port, upstreamPort }) {
  const s = state();
  if (!(Number.isInteger(upstreamPort) && upstreamPort > 0)) throw new Error('upstreamPort가 필요합니다');
  if (s.server && s.cfg.port === port && s.cfg.upstreamPort === upstreamPort) return s.cfg;
  await stopMobileListener();
  const srv = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      res.writeHead(ur.statusCode, ur.headers);
      ur.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream unavailable' }));
    });
    req.pipe(up);
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '0.0.0.0', () => { srv.off('error', reject); resolve(); });
  });
  s.server = srv;
  s.cfg = { port: srv.address().port, upstreamPort };
  return s.cfg;
}

export async function stopMobileListener() {
  const s = state();
  if (!s.server) return;
  const srv = s.server;
  s.server = null; s.cfg = null;
  await new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); });
}

/** 부팅 훅 — .mobile.json이 켜져 있으면 리스너를 복원한다. 업스트림 포트는 Next가 기동 시 박는 PORT env가
    1순위, 토글 때 저장한 값이 폴백. 실패는 경고만(부팅 경로를 막지 않는다 — 다음 토글이 다시 시도). */
export function ensureMobileListener() {
  if (state().booted) return;
  state().booted = true;
  setTimeout(async () => {
    try {
      const { loadMobile } = await import('./mobile-pairs.mjs');
      const m = await loadMobile();
      if (!m.enabled) return;
      const upstreamPort = Number(process.env.PORT) || m.upstreamPort;
      if (!upstreamPort) return;
      const cfg = await startMobileListener({ port: m.port, upstreamPort });
      console.log(`[argo] 휴대폰 리스너 0.0.0.0:${cfg.port} → 127.0.0.1:${cfg.upstreamPort}`);
    } catch (e) {
      console.warn(`[argo] 휴대폰 리스너 복원 실패: ${e.message}`);
    }
  }, 3000).unref();
}
