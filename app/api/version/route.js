// 업데이트 확인 — 데스크톱 업데이터의 정본(latest.json, GitHub Releases Latest)을 서버에서 읽어
// 현재 버전과 비교한다. 클라이언트가 GitHub로 직접 나가지 않게(CORS·오프라인·rate limit) 서버 경유,
// 아웃바운드 fetch는 1시간 캐시. 회사 데이터가 아니므로 인증 게이트 불필요.
const LATEST_URL = 'https://github.com/beyondworks/argo-agent/releases/latest/download/latest.json';

// x.y.z 숫자 비교 — pre-release 표기는 쓰지 않으므로(릴리스 드릴 정본) 세 자리면 충분하다
const cmp = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export async function GET() {
  const current = process.env.NEXT_PUBLIC_APP_VERSION || null;
  let latest = null;
  try {
    const r = await fetch(LATEST_URL, { next: { revalidate: 3600 }, signal: AbortSignal.timeout(5000) });
    if (r.ok) latest = String((await r.json())?.version ?? '').replace(/^v/, '') || null;
  } catch { /* 오프라인/차단 — 배지만 안 뜬다(기능 저하 없음) */ }
  return Response.json({ current, latest, updateAvailable: !!(current && latest && cmp(latest, current) > 0) });
}
