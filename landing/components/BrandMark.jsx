'use client';
import { useId } from 'react';

// Argo 브랜드 마크 — 정본은 레포 루트 Argo_gold.svg 하나다(파비콘·데스크톱 아이콘과 같은 도형).
// 예전엔 헤더·사이드내비가 각자 8각별을 따로 정의해 정본과 다른 마크를 그렸다(2026-07-29 정리).
// 그라디언트·필터 id는 useId로 네임스페이스한다 — 한 페이지에 두 번 이상 그려도 id가 안 부딪히게.
export default function BrandMark({ size = 18, plate = false }) {
  const uid = useId().replace(/:/g, '');
  const g = `argo-g-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 882 882" fill="none" aria-hidden>
      {plate && <rect width="882" height="882" rx="180" fill="#212121" />}
      <path
        d="M477.057 628.072L440.789 770.352L404.561 628.224L262.241 591.804L404.408 555.423L440.789 413.256L477.209 555.575L619.337 591.804L477.057 628.072Z"
        fill={`url(#${g})`}
      />
      <path
        d="M787.403 551.11H785.64L511.548 481.243L440.789 204.737L370.106 480.947L95.9297 551.11H93.8965L348.011 111H533.288L787.403 551.11Z"
        fill={`url(#${g})`}
      />
      <defs>
        <linearGradient id={g} x1="440.65" y1="111" x2="440.65" y2="770.352" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D9B866" />
          <stop offset="0.4" stopColor="#F2D98C" />
          <stop offset="0.7" stopColor="#C79E4D" />
          <stop offset="1" stopColor="#997A38" />
        </linearGradient>
      </defs>
    </svg>
  );
}
