'use client';

import Accent from '@/components/Accent';
import Icon from '@/components/family/Icon';
import { useLang } from '@/lib/i18n';

// 전환 구간(대상·시작·안심·요금·FAQ) — 문구는 전부 사전의 `${ns}.${구간}.*` 키에서 온다.

function Head({ kicker, meta }) {
  return (
    <div className="fam-head">
      <span className="mono-label">{kicker}</span>
      {meta ? <span className="mono-label mono-dim">{meta}</span> : null}
    </div>
  );
}

export function CardGrid({ ns, part, ids, id, meta, numbered = false, variant, art }) {
  const { t } = useLang();
  return (
    <section className={`fam-section${variant ? ` cv-v-${variant}` : ''}`} id={id}>
      <Head kicker={t(`${ns}.${part}.kicker`)} meta={meta} />
      <h2 className="fam-title rise cv-title">{t(`${ns}.${part}.title`)}</h2>
      <ol className={`cv-grid n${ids.length}${numbered ? ' numbered' : ''}`}>
        {ids.map((k, i) => (
          <li key={k} className="cv-card rise" style={{ '--d': `${i * 70}ms` }}>
            {art && <img className="cv-art" src={art[k]} alt="" loading="lazy" />}
            <span className="mono-label mono-dim cv-no">{String(i + 1).padStart(2, '0')}</span>
            <h3 className="cv-card-t">{t(`${ns}.${part}.${k}.t`)}</h3>
            <p className="cv-card-b">{t(`${ns}.${part}.${k}.b`)}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// 요금 — Free는 받기 구간으로, 나머지는 메일(제목만 채운 mailto)로 이어진다
export function Pricing({ ns, to, freeHref }) {
  const { t } = useLang();
  const mail = (plan) => `mailto:${to}?subject=${encodeURIComponent(t(`${ns}.price.subject.${plan}`))}`;
  const plans = [
    { id: 'free', href: freeHref, primary: true },
    { id: 'pro', href: mail('pro') },
    { id: 'ent', href: mail('ent') },
  ];
  return (
    <section className="fam-section" id="pricing">
      <Head kicker={t(`${ns}.price.kicker`)} meta="FREE · PRO · ENTERPRISE" />
      <h2 className="fam-title rise cv-title">{t(`${ns}.price.title`)}</h2>
      <div className="cv-price">
        {plans.map(({ id, href, primary }, i) => (
          <div key={id} className={`cv-plan rise${primary ? ' on' : ''}`} style={{ '--d': `${i * 70}ms` }}>
            <span className="mono-label">{t(`${ns}.price.${id}.t`)}</span>
            <strong className="cv-plan-p">{t(`${ns}.price.${id}.p`)}</strong>
            <p className="cv-card-b">{t(`${ns}.price.${id}.b`)}</p>
            <a className={`fam-btn${primary ? ' primary' : ''}`} href={href}>{t(`${ns}.price.${id}.cta`)}</a>
          </div>
        ))}
      </div>
    </section>
  );
}

// FAQ — 기본 <details>로 연다(스크립트 없이 키보드·스크린리더 동작)
export function Faq({ ns, count, split = false }) {
  const { t } = useLang();
  return (
    <section className={`fam-section${split ? ' cv-v-split' : ''}`} id="faq">
      {split ? <h2 className="fam-title rise">{t(`${ns}.faq.kicker`)}</h2> : <Head kicker={t(`${ns}.faq.kicker`)} meta={`${String(count).padStart(2, '0')}`} />}
      <div className="cv-faq">
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <details key={n} className="cv-q">
            <summary>
              <span>{t(`${ns}.faq.${n}.q`)}</span>
              <Icon name="plus" size={16} />
            </summary>
            <p><Accent text={t(`${ns}.faq.${n}.a`)} /></p>
          </details>
        ))}
      </div>
    </section>
  );
}
