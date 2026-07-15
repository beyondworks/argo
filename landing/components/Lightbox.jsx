'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const LightboxContext = createContext(null);

export function useLightbox() {
  return useContext(LightboxContext);
}

// 데모 영상 확대 뷰어 — 화면 중앙 80% 크기, 네이티브 컨트롤(일시정지·시간·탐색)
export default function LightboxProvider({ children }) {
  const [src, setSrc] = useState(null);
  const open = useCallback((s) => setSrc(s), []);
  const close = useCallback(() => setSrc(null), []);

  useEffect(() => {
    const root = document.documentElement;
    if (src) {
      // 열려 있는 동안 스냅 스크롤·배경 스크롤 정지 (SmoothScroll go()가 이 클래스를 감지해 무시)
      root.classList.add('lightbox-open');
      const onKey = (e) => {
        if (e.key === 'Escape') close();
      };
      window.addEventListener('keydown', onKey);
      return () => {
        root.classList.remove('lightbox-open');
        window.removeEventListener('keydown', onKey);
      };
    }
    return undefined;
  }, [src, close]);

  return (
    <LightboxContext.Provider value={{ open, close }}>
      {children}
      {src && (
        <div
          className="lightbox"
          onClick={close}
          onWheel={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >
          <button className="lightbox-close" onClick={close} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M5 5 L19 19 M19 5 L5 19" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
            <video src={src} controls autoPlay loop playsInline />
          </div>
        </div>
      )}
    </LightboxContext.Provider>
  );
}
