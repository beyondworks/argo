// 부트 화면 1단계 — 북극성 등장 모션(정본 엔진 ./splash/north-star.mjs, 색은 graphite: 시스템 밝기를 따른다).
// 서버를 기다리는 동안 로고를 그대로 둔다(스스로 닫지 않는다 — boot.js가 Next 화면으로 이동하면 그 화면이 같은 자리에 이어 그린다).
// 문구·진행률은 1.2초가 지나도 아직일 때만 CSS로 드러난다(boot.css). 숨 쉬기는 끈다 — 이동 순간의 크기가 Next 오버레이와 같도록.
// 등장이 끝나면 boot.js에 알린다(window.__argoIntroDone + 'argo-intro-done'). boot.js는 classic이라 이 모듈보다 먼저 돌 수 있고
// 이 모듈이 실패할 수도 있어서, boot.js는 신호와 상한을 같이 쓴다(반대 검토 #4). 인라인 스크립트 금지(CSP P0-4) — 별도 파일.
import { startNorthStar, graphitePalette } from './splash/north-star.mjs';

const splash = startNorthStar({
  root: document.getElementById('argo-splash'),
  palette: graphitePalette(window),
  autoClose: false,
  breathe: false,
});
(splash ? splash.introDone : Promise.resolve()).then(() => {
  window.__argoIntroDone = true;
  window.dispatchEvent(new Event('argo-intro-done'));
});
