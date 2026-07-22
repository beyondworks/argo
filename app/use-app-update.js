'use client';
// 데스크톱(Tauri) 앱의 "현재 버전 + 업데이트"를 위한 단일 출처.
//
// 왜 있나(2026-07-22 버그 수정): 이전엔 상단 버전 뱃지·/api/version은 NEXT_PUBLIC_APP_VERSION
// (빌드 시 package.json에서 구움)을, 설정의 업데이트 카드는 Tauri 네이티브 getVersion()
// (tauri.conf.json = 실제 설치된 앱 버전)을 읽었다. 두 값이 어긋나면(빌드 시 package.json과
// tauri.conf.json 버전 불일치) 뱃지엔 0.1.23, 카드엔 0.1.22처럼 서로 다른 "현재 버전"이 떴다.
// → 네이티브 설치 버전과 Tauri 업데이터를 유일한 진실로 삼는다. 뱃지·카드가 항상 같은 값을 보이고,
//   업데이트 여부도 업데이터가 판정하며, 새 버전이면 뱃지가 '업데이트'로 바뀌어 클릭 한 번에
//   다운로드·설치·재시작한다(클로드 데스크톱·Codex 방식). 웹(비-Tauri)은 자가 업데이트가 없으므로
//   정적 버전(NEXT_PUBLIC_APP_VERSION)만 노출하고 업데이트 어포던스는 뜨지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react';

// 데스크톱 셸 판별 — Tauri 런타임이면 자가 업데이트 경로가 존재한다.
const inTauri = () => typeof window !== 'undefined'
  && ('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));

export function useAppUpdate() {
  const [isApp, setIsApp] = useState(false);
  // 초기값은 빌드타임 버전(웹·최초 렌더용). 앱이면 마운트 후 네이티브 getVersion()으로 덮어써 진실을 맞춘다.
  const [current, setCurrent] = useState(process.env.NEXT_PUBLIC_APP_VERSION || '');
  const [available, setAvailable] = useState(null); // 새 버전 문자열 | null(없음/미확인)
  const [checked, setChecked] = useState(false);    // 최초 확인 완료 여부 — "최신입니다" 표시 구분용
  const [phase, setPhase] = useState('idle');       // idle | checking | installing | ready | error
  const updRef = useRef(null);                      // Tauri Update 핸들(다운로드·설치 대상)

  // 업데이트 확인 — Tauri 업데이터가 latest.json(argo-agent 릴리스)과 네이티브 버전을 대조.
  // 설치 중에는 상태를 건드리지 않는다(설치 흐름을 덮어쓰지 않게).
  const check = useCallback(async () => {
    if (!inTauri()) return; // 웹은 자가 업데이트 불가 — no-op
    setPhase((p) => (p === 'installing' ? p : 'checking'));
    try {
      const upd = await (await import('@tauri-apps/plugin-updater')).check();
      updRef.current = upd || null;
      setAvailable(upd ? upd.version : null);
      setChecked(true);
      setPhase((p) => (p === 'installing' ? p : 'idle'));
    } catch {
      setPhase((p) => (p === 'installing' ? p : 'error'));
    }
  }, []);

  // 즉시 설치 — 다운로드·설치(서명 검증은 Rust 업데이터가) 후 재시작. 뱃지·카드 공용 액션.
  const install = useCallback(async () => {
    if (!inTauri()) return;
    if (!updRef.current) { await check(); if (!updRef.current) return; } // 핸들 없으면 한 번 확인
    setPhase('installing');
    try {
      await updRef.current.downloadAndInstall();
      setPhase('ready');
      await (await import('@tauri-apps/plugin-process')).relaunch();
    } catch {
      setPhase('error');
    }
  }, [check]);

  // 마운트 시: 앱이면 네이티브 버전 로드 + 최초 확인, 이후 1시간마다 재확인(기존 뱃지 주기와 동일).
  useEffect(() => {
    const app = inTauri();
    setIsApp(app);
    if (!app) return;
    let alive = true;
    import('@tauri-apps/api/app').then((m) => m.getVersion())
      .then((v) => { if (alive && v) setCurrent(v); })
      .catch(() => { /* 버전 조회 실패 — 빌드타임 값 유지 */ });
    check();
    const iv = setInterval(check, 60 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [check]);

  return { isApp, current, available, checked, phase, check, install };
}
