'use client';

import { useLang } from '@/lib/i18n';
import { useLightbox } from '@/components/Lightbox';

// 데모 영상 플레이스홀더 — Female Faces식 보더 테이블 셀.
// video src가 준비되면 <video>로 스왑 (라벨/타임코드 유지)
export default function DemoPlaceholder({ label, tc = '00:00', video = null, poster = null }) {
  const { t } = useLang();
  const { open } = useLightbox();

  // 영상이 연결된 셀은 프레임 없이 영상만 인라인 — 클릭하면 라이트박스로 확대
  if (video) {
    return (
      <button type="button" className="demo-video" onClick={() => open(video)} aria-label={label}>
        <video src={video} poster={poster ?? undefined} muted loop playsInline autoPlay />
        <span className="demo-expand" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
      </button>
    );
  }

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
