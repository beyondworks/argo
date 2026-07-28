// 웹(비-Tauri) 업데이트 확인 — 서버가 argo-agent latest.json을 대신 조회한다.
// 왜 서버 프록시인가: 브라우저에서 GitHub 릴리스 자산을 직접 fetch하면 리다이렉트 대상(S3)의
// CORS에 막힌다. 성공 캐시 6시간 + 실패 음성 캐시 5분 + in-flight 코얼레싱 — 상류가 행이면
// 훅 인스턴스 2개(상단 뱃지·설정 카드)의 8초 시도가 직렬로 쌓여 16초 먹통이 되던 사슬 제거(분리 검수 실측).
import pkg from '../../../package.json';
import { cmpVersion } from '../../../src/version-compare.mjs';

const LATEST_URL = 'https://github.com/beyondworks/argo-agent/releases/latest/download/latest.json';
const CACHE_MS = 6 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 5 * 60 * 1000;

async function refresh(cache) {
  let ok = false;
  try {
    const r = await fetch(LATEST_URL, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      if (typeof j?.version === 'string') { cache.latest = j.version; cache.at = Date.now(); ok = true; }
    }
  } catch { /* 아래 failAt이 5분간 재시도를 막는다. 이전 성공 캐시는 유지(없으면 latest=null) */ }
  if (!ok) cache.failAt = Date.now();
}

export async function GET() {
  const cache = (globalThis.__argoUpdateCheck ??= { at: 0, failAt: 0, latest: null, inflight: null });
  const fresh = cache.latest && Date.now() - cache.at < CACHE_MS;
  const backoff = Date.now() - cache.failAt < FAIL_CACHE_MS;
  if (!fresh && !backoff) {
    cache.inflight ??= refresh(cache).finally(() => { cache.inflight = null; });
    await cache.inflight;
  }
  const current = pkg.version;
  const latest = cache.latest || null;
  return Response.json({
    current,
    latest,                                                 // null = 확인 불가(오프라인·사내망) — 클라가 정직하게 표기
    hasUpdate: !!latest && cmpVersion(current, latest) < 0, // 개발판(더 높은 버전)에선 false
  }, { headers: { 'cache-control': 'no-store' } });         // 셀프호스트 앞단 중간 캐시 차단(재검 권고)
}
