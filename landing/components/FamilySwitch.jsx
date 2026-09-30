'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PRODUCTS, productOf } from '@/lib/products';
import { useLang } from '@/lib/i18n';

// 상단 가운데 패밀리 스위처 — 세 제품은 각자의 페이지(/, /messenger, /office)를 가진다.
// 바탕색 전환은 CSS(html:has(.p-*))가 맡는다 — 여기는 링크와 현재 위치 표시만.
export default function FamilySwitch() {
  const current = productOf(usePathname());
  const { t } = useLang();
  return (
    <nav className="family-switch" aria-label={t('family.switch.label')}>
      {PRODUCTS.map((p) => (
        <Link
          key={p.id}
          href={p.href}
          className={`family-item${p.id === current ? ' on' : ''}`}
          aria-current={p.id === current ? 'page' : undefined}
          scroll
        >
          {p.name}
        </Link>
      ))}
    </nav>
  );
}
