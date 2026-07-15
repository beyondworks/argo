'use client';

import { useState } from 'react';
import { useLang } from '@/lib/i18n';

const TO = 'lean8kim@gmail.com';

// 무설정 문의 — 폼 내용을 담아 방문자의 메일 앱을 열어 lean8kim@gmail.com으로 전송.
export default function ContactSection() {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const subject = encodeURIComponent(`[Argo] ${t('contact.subject')}${name ? ` — ${name}` : ''}`);
    const body = encodeURIComponent(
      `${t('contact.f.name')}: ${name}\n${t('contact.f.email')}: ${email}\n\n${msg}`
    );
    window.location.href = `mailto:${TO}?subject=${subject}&body=${body}`;
  };

  return (
    <section className="contact-section" id="contact">
      <div className="contact-head">
        <span className="mono-label">{t('contact.kicker')}</span>
        <a className="mono-label mono-dim contact-mail" href={`mailto:${TO}`}>
          {TO}
        </a>
      </div>
      <h2 className="contact-title">{t('contact.title')}</h2>
      <p className="contact-sub">{t('contact.sub')}</p>

      <form className="contact-form" onSubmit={submit}>
        <div className="contact-row">
          <label className="contact-field">
            <span className="contact-flabel">{t('contact.f.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </label>
          <label className="contact-field">
            <span className="contact-flabel">{t('contact.f.email')}</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </label>
        </div>
        <label className="contact-field">
          <span className="contact-flabel">{t('contact.f.msg')}</span>
          <textarea rows={5} value={msg} onChange={(e) => setMsg(e.target.value)} required />
        </label>
        <div className="contact-actions">
          <button type="submit" className="contact-submit">
            {t('contact.send')}
          </button>
          <span className="contact-note">{t('contact.note')}</span>
        </div>
      </form>
    </section>
  );
}
