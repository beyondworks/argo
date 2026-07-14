'use client';

import { useLang } from '@/lib/i18n';

// 챕터 사이 아트 브릿지 — 크림 라인아트를 액자(plate)에 걸어 블랙 갤러리처럼
export default function Interlude({ children }) {
  const { t } = useLang();
  return (
    <section className="interlude">
      <div className="plate">{children}</div>
      <span className="interlude-caption mono-label mono-dim">{t('interlude.cap')}</span>
    </section>
  );
}
