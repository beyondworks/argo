'use client';

import { useLang } from '@/lib/i18n';
import { MSGR_DL, MSGR_RELEASES } from '@/lib/downloads';

// 팀 메신저 — 다운로드 섹션과 같은 문법(헤드·대제목·버튼 묶음·노트). 스타 게이트는 없다(메신저는 조직용, 개인 앱 다운로드 뒤에 온다).
export default function MessengerSection() {
  const { t } = useLang();
  return (
    <section className="download-section messenger-section" id="messenger">
      <div className="download-head">
        <span className="mono-label">{t('msgr.kicker')}</span>
        <span className="mono-label mono-dim">TEAM · MAC · WIN</span>
      </div>
      <h2 className="download-title">{t('msgr.title')}</h2>
      <p className="download-sub">{t('msgr.sub')}</p>
      <ul className="messenger-points">
        <li>{t('msgr.p1')}</li>
        <li>{t('msgr.p2')}</li>
        <li>{t('msgr.p3')}</li>
      </ul>
      <div className="download-buttons">
        <a className="dl-btn primary" href={MSGR_DL.silicon}>{t('download.mac')}</a>
        <a className="dl-btn ghost" href={MSGR_DL.win}>{t('download.win')}</a>
      </div>
      <span className="download-note">
        {t('msgr.note')}
        {' · '}
        <a href={MSGR_DL.silicon} style={{ color: 'inherit', textDecoration: 'underline' }}>Apple Silicon</a>
        {' / '}
        <a href={MSGR_DL.intel} style={{ color: 'inherit', textDecoration: 'underline' }}>Intel Mac</a>
        {' / '}
        <a href={MSGR_DL.win} style={{ color: 'inherit', textDecoration: 'underline' }}>Windows</a>
        {' / '}
        <a href={MSGR_RELEASES} style={{ color: 'inherit', textDecoration: 'underline' }}>{t('msgr.all')}</a>
      </span>
    </section>
  );
}
