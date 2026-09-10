import { useEffect } from 'react';
import { isMobilePlatform } from './platform.js';

// Visual viewport follows the phone keyboard; CSS still owns desktop layout.
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    const style = document.documentElement.style;
    const update = () => {
      style.setProperty('--msgr-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      style.setProperty('--msgr-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      document.body.classList.toggle('msgr-short-viewport',
        (isMobilePlatform || window.matchMedia('(pointer: coarse)').matches)
        && (viewport?.width ?? window.innerWidth) > 720
        && (viewport?.height ?? window.innerHeight) <= 320);
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      style.removeProperty('--msgr-viewport-height');
      style.removeProperty('--msgr-viewport-top');
      document.body.classList.remove('msgr-short-viewport');
    };
  }, []);
}
