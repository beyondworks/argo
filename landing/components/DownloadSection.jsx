'use client';

import { useLang } from '@/lib/i18n';
import { DL, useStarGate, detectMacTarget } from './StarModal';

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.08ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3 5.1 10.5 4v7.5H3V5.1ZM3 12.5h7.5V20L3 18.9v-6.4ZM11.5 3.85 21 2.5v9H11.5v-7.65ZM21 12.5v9l-9.5-1.35V12.5H21Z" />
    </svg>
  );
}

export default function DownloadSection() {
  const { t } = useLang();
  const { gate, modal } = useStarGate();
  return (
    <section className="download-section" id="download">
      <div className="download-head">
        <span className="mono-label">{t('download.kicker')}</span>
        <span className="mono-label mono-dim">MAC · WIN</span>
      </div>
      <h2 className="download-title">{t('download.title')}</h2>
      <p className="download-sub">{t('download.sub')}</p>
      <div className="download-buttons">
        <a className="dl-btn primary" href={DL.silicon} onClick={(e) => gate(e, detectMacTarget())}>
          <AppleIcon />
          {t('download.mac')}
        </a>
        <a className="dl-btn ghost" href={DL.win} onClick={(e) => gate(e, 'win')}>
          <WindowsIcon />
          {t('download.win')}
        </a>
      </div>
      <span className="download-note">
        {t('download.note')}
        {' · '}
        <a href={DL.silicon} onClick={(e) => gate(e, 'silicon')} style={{ color: 'inherit', textDecoration: 'underline' }}>Apple Silicon</a>
        {' / '}
        <a href={DL.intel} onClick={(e) => gate(e, 'intel')} style={{ color: 'inherit', textDecoration: 'underline' }}>Intel Mac</a>
        {' / '}
        <a href={DL.win} onClick={(e) => gate(e, 'win')} style={{ color: 'inherit', textDecoration: 'underline' }}>Windows</a>
      </span>
      {modal}
    </section>
  );
}
