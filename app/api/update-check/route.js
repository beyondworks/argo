// 웹(비-Tauri) 업데이트 확인 — 서버가 argo-agent latest.json을 대신 조회한다.
// 왜 서버 프록시인가: 브라우저에서 GitHub 릴리스 자산을 직접 fetch하면 리다이렉트 대상(S3)의
// CORS에 막힌다. 서버는 무관 + 6시간 캐시로 릴리스 엔드포인트 부하·지연을 흡수한다.
// (데스크톱은 Tauri 업데이터가 같은 latest.json을 네이티브에서 읽는다 — use-app-update.jsx.)
import pkg from '../../../package.json';

const LATEST_URL = 'https://github.com/beyondworks/argo-agent/releases/latest/download/latest.json';
const CACHE_MS = 6 * 60 * 60 * 1000;

/** 버전 비교(순수) — x.y.z 숫자 파트 우선, 파트 수 다르면 짧은 쪽 0 패딩. a<b → -1. (export: 테스트용) */
export function cmpVersion(a, b) {
  const pa = String(a ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

export async function GET() {
  const cache = (globalThis.__argoUpdateCheck ??= { at: 0, latest: null });
  if (!cache.latest || Date.now() - cache.at > CACHE_MS) {
    try {
      const r = await fetch(LATEST_URL, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const j = await r.json();
        if (typeof j?.version === 'string') { cache.latest = j.version; cache.at = Date.now(); }
      }
    } catch { /* 조회 실패 — 이전 캐시 유지(없으면 null). 확인 불가는 hasUpdate:false로 정직하게 */ }
  }
  const current = pkg.version;
  const latest = cache.latest;
  return Response.json({
    current,
    latest,                                       // null = 확인 불가(오프라인·사내망)
    hasUpdate: !!latest && cmpVersion(current, latest) < 0, // 개발판(더 높은 버전)에서 오탐 없게 미만 비교
  });
}
