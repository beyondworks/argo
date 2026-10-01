// 랜딩 체험판 — VITE_OFFICE_DEMO=1로 빌드한 체험 전용 배포에서만 켜진다(운영 오피스 빌드에는 없음).
// 서버 설정 없이 빌드하므로 예시 데이터 모드로 실행되고, 열 때마다 처음 상태로 시작하며, 언어는 랜딩이 ?lang=으로 넘긴다.
// main.jsx의 첫 import다 — 다른 모듈이 저장소를 읽기 전에 비워야 한다.
export const DEMO = import.meta.env.VITE_OFFICE_DEMO === '1';

if (DEMO && typeof window !== 'undefined') {
  try {
    localStorage.clear();
    sessionStorage.clear();
    const lang = new URLSearchParams(location.search).get('lang');
    if (lang === 'ko' || lang === 'en') localStorage.setItem('argo-lang', lang);
  } catch { /* 저장소를 못 쓰면 이번 화면만 */ }
  try { indexedDB.deleteDatabase('keyval-store'); } catch { /* 없음 */ }
}
