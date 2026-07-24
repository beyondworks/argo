'use client';
// 같은 버전 재배포 감지 — 서버 buildId가 바뀌면(상주 재배포·사이드카 교체) 이미 열린 웹뷰의 번들은
// 낡은 청크·내비 페이로드를 참조해 화면 전환이 버벅거리고 일부 클릭이 조용히 죽는다
// (실사고 2026-07-25: 재배포 후 크루 카드 엔진 셀렉터·모델 선택 클릭 불능). 버전 문자열이 같아
// 업데이트 칩도 못 잡는 케이스 — buildId를 감시해 1회 전체 새로고침으로 자가 치유한다.
import { useEffect } from 'react';

export default function BuildWatch() {
  useEffect(() => {
    let first = null;
    let stopped = false;
    const check = async () => {
      try {
        const r = await fetch('/api/ping', { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!j?.buildId || stopped) return;
        if (first === null) { first = j.buildId; return; }
        if (j.buildId === first) return;
        // 같은 buildId로의 재로드는 1회만 — 플랩(서버 교대 등)이 있어도 새로고침 루프에 빠지지 않는다
        try { if (sessionStorage.getItem('argo-reloaded-for') === j.buildId) return; } catch { /* 프라이빗 모드 */ }
        // 작성 중인 입력이 있으면 이번 주기는 미룬다 — 새로고침으로 입력을 날리지 않는다.
        // 마커 기록은 반드시 이 가드 뒤, reload 직전에 — 가드에서 미뤄진 배포가 마커 선기록 탓에
        // 영구 취소되던 결함(사후 검수 2026-07-25) 방지.
        const el = document.activeElement;
        if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && el.value) return;
        try { sessionStorage.setItem('argo-reloaded-for', j.buildId); } catch { /* 프라이빗 모드 — 가드 없이 1회 시도 */ }
        window.location.reload();
      } catch { /* 서버 재시작 중 — 다음 주기에 재시도 */ }
    };
    check();
    const iv = setInterval(check, 60_000);
    return () => { stopped = true; clearInterval(iv); };
  }, []);
  return null;
}
