'use client';
// 다운로드 전 깃헙 스타 요청 모달 — 다운로드를 볼모로 잡지 않는다("그냥 다운로드" 항상 제공).
// "스타 누르고 다운로드" → /api/star/start?t=<타깃> (깃헙 승인 → 서버가 스타 → 해당 설치파일 직다운로드).
import { useEffect, useState, useCallback } from 'react';
import { useLang } from '@/lib/i18n';

export const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
const BASE = 'https://github.com/beyondworks/argo-agent/releases/latest/download/';
// 고정 파일명 직다운로드 — release.yml이 매 릴리스마다 같은 이름으로 발행한다
export const DL = {
  silicon: `${BASE}argo-macos-apple-silicon.dmg`,
  intel: `${BASE}argo-macos-intel.dmg`,
  win: `${BASE}argo-windows-setup.exe`,
};

// 스타 완료(서버 쿠키) 또는 "그냥 다운로드" 선택(localStorage) 후에는 다시 묻지 않는다
export const starAsked = () =>
  typeof document !== 'undefined' &&
  (/(?:^|;\s*)argo_starred=1/.test(document.cookie) || localStorage.getItem('argo-star-skip') === '1');

// mac에서 Intel 감지 — WebGL 렌더러 문자열(Chrome 계열에서 유효, Safari는 둘 다 'Apple GPU' → Silicon 기본)
function isIntelMac() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return /intel/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
  } catch { return false; }
}

/** 접속 기기에 맞는 설치파일 타깃 추정 */
export function detectTarget() {
  if (typeof navigator === 'undefined') return 'silicon';
  if (/windows/i.test(navigator.userAgent)) return 'win';
  return isIntelMac() ? 'intel' : 'silicon';
}

/** mac 전용 버튼용 — Windows에서 눌러도 mac 파일을 준다 */
export function detectMacTarget() {
  if (typeof navigator === 'undefined') return 'silicon';
  return isIntelMac() ? 'intel' : 'silicon';
}

/** 스타 게이트 훅 — 버튼 onClick에 gate(e, 타깃)를 걸면:
 *  이미 스타/스킵한 사람 → 즉시 직다운로드, 아니면 → 모달. */
export function useStarGate() {
  const [target, setTarget] = useState(null); // null = 모달 닫힘
  const gate = useCallback((e, t) => {
    e.preventDefault();
    const resolved = t || detectTarget();
    if (starAsked()) { window.open(DL[resolved], '_blank', 'noopener'); return; }
    setTarget(resolved);
  }, []);
  const modal = target ? <StarModal target={target} onClose={() => setTarget(null)} /> : null;
  return { gate, modal };
}

export default function StarModal({ target = 'silicon', onClose }) {
  const { t } = useLang();
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const skip = () => {
    try { localStorage.setItem('argo-star-skip', '1'); } catch { /* private 모드 등 */ }
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('star.title')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center',
        justifyContent: 'center', background: 'rgba(4, 10, 22, 0.72)', backdropFilter: 'blur(6px)',
      }}
    >
      <div
        style={{
          width: 'min(420px, calc(100vw - 40px))', padding: '28px 26px', borderRadius: 16,
          background: '#0b1526', border: '1px solid rgba(214, 178, 94, 0.25)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <span aria-hidden style={{ fontSize: 26, lineHeight: 1 }}>★</span>
        <h3 style={{ margin: 0, fontSize: 19, color: '#f2ecdd' }}>{t('star.title')}</h3>
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.65, color: 'rgba(242, 236, 221, 0.72)' }}>
          {t('star.desc')}
        </p>
        <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
          <a
            className="dl-btn primary"
            href={`/api/star/start?t=${target}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            style={{ flex: '1 1 auto', justifyContent: 'center' }}
          >
            {t('star.yes')}
          </a>
          <a
            className="dl-btn ghost"
            href={DL[target]}
            target="_blank"
            rel="noopener noreferrer"
            onClick={skip}
            style={{ flex: '1 1 auto', justifyContent: 'center' }}
          >
            {t('star.no')}
          </a>
        </div>
        <span style={{ fontSize: 11.5, color: 'rgba(242, 236, 221, 0.45)' }}>{t('star.hint')}</span>
      </div>
    </div>
  );
}
