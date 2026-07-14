'use client';

import { useLang } from '@/lib/i18n';

// 데모 영상 플레이스홀더 — Female Faces식 보더 테이블 셀.
// video src가 준비되면 <video>로 스왑 (라벨/타임코드 유지)
export default function DemoPlaceholder({ label, tc = '00:00', video = null, poster = null }) {
  const { t } = useLang();
  return (
    <div className="demo-ph">
      <div className="demo-topbar">
        <span className="mono-label mono-dim">[ {t('demo.tag')} ]</span>
        <svg width="14" height="14" viewBox="0 0 30 30" aria-hidden>
          <path d="M15 0 L18 12 L30 15 L18 18 L15 30 L12 18 L0 15 L12 12 Z" fill="currentColor" />
        </svg>
      </div>
      <div className="demo-body">
        {video ? (
          <video src={video} poster={poster ?? undefined} muted loop playsInline autoPlay />
        ) : (
          <div className="demo-play" aria-hidden>
            <svg width="15" height="15" viewBox="0 0 16 16">
              <path d="M4 2 L13 8 L4 14 Z" />
            </svg>
          </div>
        )}
      </div>
      <div className="demo-bottombar">
        <span className="mono-label">{label}</span>
        <span className="mono-label mono-dim">{tc}</span>
      </div>
    </div>
  );
}
