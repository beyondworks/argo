import { useEffect } from 'react';
import { isMobilePlatform } from './platform.js';
import { viewportVars, keyboardTargetFor } from './viewport-vars.mjs';

// 폰 키보드가 떠 있는 동안만 visualViewport 높이·오프셋을 CSS 변수로 넘긴다. 그 외에는 변수를 지워 CSS 기본(100dvh)이 쓰인다.
// 부팅 직후 visualViewport가 잠깐 작게 보고된 값이 변수에 남아 셸이 화면의 2/3 높이로 굳던 제보(유건 2026-09-14, 실기기 스크린샷)를 막는다.
const keyboardOpen = () => keyboardTargetFor(document.activeElement);

export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    const update = () => {
      const { vars, short } = viewportVars({ keyboard: keyboardOpen(), height: viewport?.height ?? window.innerHeight, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, coarse: isMobilePlatform || window.matchMedia('(pointer: coarse)').matches });
      for (const k of ['--msgr-viewport-height', '--msgr-viewport-top']) { if (vars) style.setProperty(k, vars[k]); else style.removeProperty(k); }
      document.body.classList.toggle('msgr-short-viewport', short);
      document.documentElement.classList.toggle('msgr-kb', !!vars); // 키보드 모드 — 어떤 입력칸이든(설정의 부서·직급 칸 포함) 폰 셸이 탭바 자리를 비운다(유건 제보 2026-09-24)
      // 아이패드 데스크톱 배치(총괄 실측 2026-09-27): .msgr-shell만 position:fixed로는 부족했다 — WKWebView가
      // 포커스한 칸을 보여주려고 자신의 네이티브 스크롤뷰(문서 전체를 담는 컨테이너)를 이동시키면, 그 안의
      // position:fixed 요소도 화면 밖으로 함께 끌려간다(레일 로고·채널 머리 소실을 body 최상위 고정 노드로도
      // 재현 — .msgr-shell만의 문제가 아니었다). body 자체를 fixed로 만들면 WKWebView가 스크롤할 "문서"가
      // 없어져 그 동작 자체가 일어나지 않는다(iOS 하이브리드 앱에서 흔히 쓰는 처방).
      document.body.style.position = vars ? 'fixed' : '';
      document.body.style.width = vars ? '100%' : '';
      document.body.style.top = vars ? '0' : '';
      document.body.style.left = vars ? '0' : '';
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    document.addEventListener('focusin', update);
    const onFocusOut = () => setTimeout(update, 50); // 키보드가 내려간 뒤 값으로
    document.addEventListener('focusout', onFocusOut);
    // 두 손가락 확대·축소 차단 — WKWebView는 뷰포트 user-scalable=no를 따르지만 제스처 이벤트까지 막아 둔다(유건 2026-09-14)
    const noGesture = (e) => e.preventDefault();
    const noPinch = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
    document.addEventListener('gesturestart', noGesture, { passive: false });
    document.addEventListener('touchmove', noPinch, { passive: false });
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', onFocusOut); // 언마운트 뒤 키보드 표지를 다시 켜지 않게(재검수 L5)
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('touchmove', noPinch);
      style.removeProperty('--msgr-viewport-height');
      style.removeProperty('--msgr-viewport-top');
      document.body.classList.remove('msgr-short-viewport');
      document.documentElement.classList.remove('msgr-kb');
      document.body.style.position = ''; document.body.style.width = ''; document.body.style.top = ''; document.body.style.left = '';
    };
  }, []);
}
