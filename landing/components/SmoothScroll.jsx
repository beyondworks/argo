'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import Lenis from 'lenis';
import { gsap, ScrollTrigger, prefersReducedMotion } from '@/lib/gsap';

const LenisContext = createContext({ lenis: null });

export function useLenis() {
  return useContext(LenisContext);
}

export default function SmoothScroll({ children }) {
  const [lenis, setLenis] = useState(null);
  const rafCb = useRef(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      document.documentElement.classList.add('no-motion');
      return undefined;
    }

    const instance = new Lenis({ lerp: 0.11, wheelMultiplier: 1 });
    instance.on('scroll', ScrollTrigger.update);
    rafCb.current = (time) => instance.raf(time * 1000);
    gsap.ticker.add(rafCb.current);
    gsap.ticker.lagSmoothing(0);
    setLenis(instance);
    window.__lenis = instance;
    window.__ST = ScrollTrigger;

    return () => {
      gsap.ticker.remove(rafCb.current);
      instance.destroy();
      setLenis(null);
    };
  }, []);

  return <LenisContext.Provider value={{ lenis }}>{children}</LenisContext.Provider>;
}
