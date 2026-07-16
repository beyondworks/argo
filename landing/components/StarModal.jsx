'use client';
// 다운로드 전 깃헙 스타 요청 모달 — 다운로드를 볼모로 잡지 않는다("그냥 다운로드" 항상 제공).
// "스타 누르고 다운로드" → /api/star/start (깃헙 승인 → 서버가 스타 → 릴리스로 이동).
import { useEffect } from 'react';
import { useLang } from '@/lib/i18n';

export const RELEASES = 'https://github.com/beyondworks/argo-agent/releases/latest';
// 스타 완료(서버 쿠키) 또는 "그냥 다운로드" 선택(localStorage) 후에는 다시 묻지 않는다
export const starAsked = () =>
  typeof document !== 'undefined' &&
  (/(?:^|;\s*)argo_starred=1/.test(document.cookie) || localStorage.getItem('argo-star-skip') === '1');

export default function StarModal({ onClose }) {
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
            href="/api/star/start"
            target="_blank"
            rel="noopener noreferrer"
            onClick={onClose}
            style={{ flex: '1 1 auto', justifyContent: 'center' }}
          >
            {t('star.yes')}
          </a>
          <a
            className="dl-btn ghost"
            href={RELEASES}
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
