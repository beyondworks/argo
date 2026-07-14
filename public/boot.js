// 데스크톱 셸 부팅 스크립트 — index.html에서 인라인 분리(CSP 견고성, P0-4).
// 상주 서버 후보 — 이 기기(3001) 우선, 설치기 기본(3999) 폴백. 준비 안 됐으면 재시도.
var TARGETS = ['http://localhost:3001', 'http://localhost:3999'];
function probe(i) {
  if (i >= TARGETS.length) {
    document.getElementById('hint').textContent = '로컬 서버 준비 중… 잠시만요';
    setTimeout(function () { probe(0); }, 1500);
    return;
  }
  fetch(TARGETS[i] + '/login', { mode: 'no-cors' })
    .then(function () { location.replace(TARGETS[i]); })
    .catch(function () { probe(i + 1); });
}
probe(0);
