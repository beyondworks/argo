// 버전 비교(순수) — update-check 라우트·테스트 공용. 'v' 접두 허용(재검: v1.3.0 릴리스 태그 형태가
// 접두 미제거로 NaN→0이 되어 업데이트를 놓치던 결함). x.y.z 숫자 파트 비교, 파트 수 다르면 0 패딩. a<b → -1.
export function cmpVersion(a, b) {
  const norm = (x) => String(x ?? '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = norm(a); const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
