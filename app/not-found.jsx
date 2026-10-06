'use client';
// 없는 주소 — Next 기본 영어 404(순백·순흑, 돌아갈 길 없음) 대신 앱 모양·화면 언어로(UX-A14, 2026-10-05).
// 회사 없음 화면(shell.notFound)과 같은 문구·링크 패턴, graphite 토큰(globals.css)을 그대로 쓴다.
import Link from 'next/link';
import { useLang } from './i18n';

export default function NotFound() {
  const { t } = useLang();
  return (
    <main style={{ minHeight: 'calc(100vh / var(--z, 1))', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--fg)', padding: 24 }}>
      <div className="empty" style={{ display: 'grid', gap: 12, justifyItems: 'center', textAlign: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 650 }}>{t('notFound.title')}</span>
        <span style={{ fontSize: 12.5, color: 'var(--fg-2)' }}>{t('notFound.desc')}</span>
        <Link href="/" className="btn btn-primary sm" style={{ textDecoration: 'none' }}>{t('shell.backHome')}</Link>
      </div>
    </main>
  );
}
