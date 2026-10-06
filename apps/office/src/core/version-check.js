// 새 버전 안내(유건 10/4) — 열어 둔 탭이 새 배포를 알아채면 "새 버전이 있습니다 · 새로고침"을 띄운다(App.jsx NewVersionBar).
// 배포 전부터 열려 있던 탭의 옛 편집기가 새 블록이 든 페이지를 빈 문서로 여는 사고(16차 검수 M3)를 다음 배포부터 막는다.
// 부하: 탭으로 돌아올 때 10분에 한 번까지 정적 파일 version.json 하나(DB 호출 아님). 개발 서버·데스크톱 앱(파일이 앱 안에 묶임)은 확인하지 않는다.
import { useSyncExternalStore } from 'react';
import { isDesktop } from './platform.js';

const LOCAL = typeof __OFFICE_BUILD__ === 'string' ? __OFFICE_BUILD__ : ''; // eslint-disable-line no-undef -- vite define(build-id.mjs)
export const versionDue = ({ now, last, hidden }) => !hidden && now - last >= 10 * 60_000;
export const isNewer = (remote, local) => !!remote && !!local && remote !== local;

let fresh = false, last = Date.now();
const subs = new Set();
async function check() {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    const remote = res.ok ? (await res.json())?.id : '';
    if (isNewer(remote, LOCAL)) { fresh = true; subs.forEach((f) => f()); }
  } catch { /* 오프라인 등 — 다음 복귀 때 다시 */ }
}
if (import.meta.env?.PROD && LOCAL && typeof document !== 'undefined' && !isDesktop()) {
  const onReturn = () => {
    const now = Date.now();
    if (fresh || !versionDue({ now, last, hidden: document.hidden })) return;
    last = now;
    check();
  };
  document.addEventListener('visibilitychange', onReturn);
  addEventListener('focus', onReturn);
}
export const useNewVersion = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => fresh, () => false);
