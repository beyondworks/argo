import { useEffect } from 'react';
import { isMobilePlatform } from './platform.js';
import { viewportVars } from './viewport-vars.mjs';

// 폰 키보드가 떠 있는 동안만 visualViewport 높이·오프셋을 CSS 변수로 넘긴다. 그 외에는 변수를 지워 CSS 기본(100dvh)이 쓰인다.
// 부팅 직후 visualViewport가 잠깐 작게 보고된 값이 변수에 남아 셸이 화면의 2/3 높이로 굳던 제보(유건 2026-09-14, 실기기 스크린샷)를 막는다.
const KEYBOARD_TARGET = 'input, textarea, [contenteditable="true"]';
const keyboardOpen = () => !!document.activeElement?.closest?.(KEYBOARD_TARGET);

export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    const update = () => {
      const { vars, short } = viewportVars({ keyboard: keyboardOpen(), height: viewport?.height ?? window.innerHeight, top: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth, coarse: isMobilePlatform || window.matchMedia('(pointer: coarse)').matches });
      for (const k of ['--msgr-viewport-height', '--msgr-viewport-top']) { if (vars) style.setProperty(k, vars[k]); else style.removeProperty(k); }
      document.body.classList.toggle('msgr-short-viewport', short);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => setTimeout(update, 50)); // 키보드가 내려간 뒤 값으로
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
      document.removeEventListener('gesturestart', noGesture);
      document.removeEventListener('touchmove', noPinch);
      style.removeProperty('--msgr-viewport-height');
      style.removeProperty('--msgr-viewport-top');
      document.body.classList.remove('msgr-short-viewport');
    };
  }, []);
}
