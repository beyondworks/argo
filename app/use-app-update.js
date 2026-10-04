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
import { MOVE_REQUIRED, updateErrorReason, updateLocationIssue } from './update-location.mjs';

// The settings card and shell use separate hook instances; installation is app-wide.
let sharedInstallPhase = 'idle';
const installListeners = new Set();
const publishInstallPhase = (phase) => {
  sharedInstallPhase = phase;
  for (const notify of installListeners) notify(phase);
};
const installationBusy = () => sharedInstallPhase === 'installing' || sharedInstallPhase === 'ready';
// 마지막 설치 실패 { reason, raw } — 뱃지에서 누른 설치가 실패해도 설정 카드가 이유를 보인다(고객 문의 2026-10-03·10-04: "확인하지 못했어요"만 떴다).
// 새 설치가 시작되거나 사용자가 '업데이트 확인'을 누를 때만 지운다 — 카드 마운트·1시간 주기의 자동 확인은 지우지 않는다(분리 검수 MEDIUM-1).
// reason 'relaunch' = 설치는 끝났고 재시작만 실패(설정 카드가 다시 열라고 안내).
let sharedInstallError = null;
const installErrorListeners = new Set();
const publishInstallError = (error) => {
  sharedInstallError = error;
  for (const notify of installErrorListeners) notify(error);
};

// 데스크톱 셸 판별 — Tauri 런타임이면 자가 업데이트 경로가 존재한다.
// export — 설정의 시스템 권한 카드 등이 재사용(판별 로직 복사본 증식 방지, 분리 검수 L2).
export const inTauri = () => typeof window !== 'undefined'
  && ('__TAURI_INTERNALS__' in window || navigator.userAgent.includes('Tauri'));

export function useAppUpdate() {
  const [isApp, setIsApp] = useState(false);
  // 초기값은 빌드타임 버전(웹·최초 렌더용). 앱이면 마운트 후 네이티브 getVersion()으로 덮어써 진실을 맞춘다.
  const [current, setCurrent] = useState(process.env.NEXT_PUBLIC_APP_VERSION || '');
  const [versionReady, setVersionReady] = useState(false);
  const [available, setAvailable] = useState(null); // 새 버전 문자열 | null(없음/미확인)
  const [checked, setChecked] = useState(false);    // 최초 확인 완료 여부 — "최신입니다" 표시 구분용
  const [phase, setPhase] = useState('idle');       // idle | checking | installing | ready | error
  const [installError, setInstallError] = useState(sharedInstallError); // 설치 실패 { reason, raw } | null — 확인 실패와 구분
  const [location, setLocation] = useState(null);   // 맥 설치 위치 문제 { issue, path } | null(문제 없음·옛 앱이라 모름)
  const locationRef = useRef(null);
  const updRef = useRef(null);                      // Tauri Update 핸들(다운로드·설치 대상)

  // 업데이트 확인 — Tauri 업데이터가 latest.json(argo-agent 릴리스)과 네이티브 버전을 대조.
  // 설치 중에는 상태를 건드리지 않는다(설치 흐름을 덮어쓰지 않게). byUser = 설정 카드의 '업데이트 확인' 버튼.
  const check = useCallback(async ({ byUser = false } = {}) => {
    if (installationBusy()) return;
    if (byUser && sharedInstallError) publishInstallError(null);
    if (!inTauri()) {
      // 웹(상주·셀프호스트) — 자가 업데이트는 없지만 **새 버전 존재는 알 수 있어야 한다**
      // (실사용 요청 2026-07-27 "웹버전만 쓰는 사람 업데이트 쉽게"). 서버 프록시(/api/update-check)가
      // latest.json을 대신 읽는다(브라우저 직접 fetch는 릴리스 S3 CORS에 막힘).
      setPhase('checking');
      try {
        const r = await fetch('/api/update-check').then((x) => x.json());
        if (r.current) setCurrent(r.current);
        if (r.latest == null) {
          // 확인 불가(오프라인·사내망) — '최신입니다'로 오보고하지 않는다(분리 검수 차단2: 정직성).
          setAvailable(null); setChecked(false); setPhase('error');
          return;
        }
        setAvailable(r.hasUpdate ? r.latest : null);
        setChecked(true);
        setPhase('idle');
      } catch { setPhase('error'); }
      return;
    }
    setPhase(() => (installationBusy() ? sharedInstallPhase : 'checking'));
    try {
      const upd = await (await import('@tauri-apps/plugin-updater')).check();
      updRef.current = upd || null;
      setAvailable(upd ? upd.version : null);
      setChecked(true);
      setPhase(() => (installationBusy() ? sharedInstallPhase : 'idle'));
    } catch {
      setPhase(() => (installationBusy() ? sharedInstallPhase : 'error'));
    }
  }, []);

  // 즉시 설치 — 다운로드·설치(서명 검증은 Rust 업데이터가) 후 재시작. 뱃지·카드 공용 액션.
  // 실패를 남겼으면 false를 돌려준다 — 뱃지는 이유가 보이는 설정 카드로 보낸다.
  const install = useCallback(async () => {
    if (!inTauri() || installationBusy()) return;
    // 옮기기 전에는 설치가 성공할 수 없는 위치 — 내려받지 않고 이유를 남긴다(설정 카드가 옮기는 방법을 보인다)
    const issue = locationRef.current?.issue;
    if (issue && MOVE_REQUIRED.has(issue)) { publishInstallError({ reason: issue, raw: '' }); publishInstallPhase('error'); return false; }
    if (!updRef.current) { await check(); if (!updRef.current) return; } // 핸들 없으면 한 번 확인
    if (installationBusy()) return;
    publishInstallError(null);
    publishInstallPhase('installing');
    const message = (e) => String(e?.message ?? e ?? '').slice(0, 300);
    let processPlugin;
    try {
      // 재시작 모듈은 내려받기 전에 불러 둔다. 본체 화면은 앱 묶음 안 서버가 주므로, 설치로 묶음이 새 버전으로 바뀐 뒤에는
      // 옛 빌드의 JS 조각을 더 받을 수 없다 — 설치 뒤에 불러오면 조각 이름이 바뀐 버전으로 업데이트할 때 relaunch까지 가지 못한다
      // (2026-10-04 실제 맥 확인: 디스크는 새 버전, 앱은 옛 버전 그대로).
      // 구조 분해로 받지 않는다 — webpack이 쓰지 않는 export(exit)를 빼면서 조각(6638) 내용이 공개본과 달라진다.
      processPlugin = await import('@tauri-apps/plugin-process');
      await updRef.current.downloadAndInstall();
    } catch (e) {
      const raw = message(e);
      publishInstallError({ reason: updateErrorReason(raw), raw });
      publishInstallPhase('error');
      return false;
    }
    publishInstallPhase('ready');
    try {
      await processPlugin.relaunch();
    } catch (e) {
      publishInstallError({ reason: 'relaunch', raw: message(e) }); // 설치는 됐다 — 'ready'로 두어 재설치를 막는다
      return false;
    }
  }, [check]);

  useEffect(() => {
    installListeners.add(setPhase);
    installErrorListeners.add(setInstallError);
    if (installationBusy()) setPhase(sharedInstallPhase);
    return () => { installListeners.delete(setPhase); installErrorListeners.delete(setInstallError); };
  }, []);

  // 마운트 시: 앱이면 네이티브 버전 로드 + 최초 확인, 이후 1시간마다 재확인(기존 뱃지 주기와 동일).
  useEffect(() => {
    const app = inTauri();
    setIsApp(app);
    let alive = true;
    if (app) {
      import('@tauri-apps/api/app').then((m) => m.getVersion())
        .then((v) => { if (alive && v) { setCurrent(v); setVersionReady(true); } })
        .catch(() => { /* 버전 조회 실패 — 빌드타임 값 유지 */ });
      // 설치 위치(맥) — 마운트당 한 번. 이 명령이 없는 옛 앱(상주 서버만 새 버전일 때)은 거절되므로 모름(null)으로 둔다.
      // @tauri-apps/api/core를 여기서 불러오면 재시작 모듈과 같은 JS 조각(6638)의 내용이 바뀐다. 0.1.94 이하는 설치 뒤에
      // 그 조각을 옛 이름으로 받아 재시작하므로, 조각을 공개본과 같게 두려고 내부 invoke(core의 invoke가 감싸는 함수)를 직접 쓴다.
      Promise.resolve().then(() => window.__TAURI_INTERNALS__.invoke('update_location'))
        .then((facts) => { const issue = updateLocationIssue(facts); const loc = issue ? { issue, path: facts.path } : null; locationRef.current = loc; if (alive) setLocation(loc); })
        .catch(() => {});
    } else setVersionReady(true);
    // 웹도 최초 확인 + 1시간 주기 재확인 — check()가 환경별 경로(Tauri 업데이터/서버 프록시)를 스스로 고른다
    check();
    const iv = setInterval(check, 60 * 60 * 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [check]);

  return { isApp, current, versionReady, available, checked, phase, check, install, installError, location };
}
