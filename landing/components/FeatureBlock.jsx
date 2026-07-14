'use client';

import { forwardRef } from 'react';
import { useLang } from '@/lib/i18n';
import { TOTAL_FEATURES } from '@/lib/chapters';
import DemoPlaceholder from '@/components/DemoPlaceholder';

const FeatureBlock = forwardRef(function FeatureBlock({ feature, chapterId, order, mirror }, ref) {
  const { t } = useLang();
  return (
    <div className={`feature-block${mirror ? ' mirror' : ''}`} ref={ref}>
      <div className="feature-copy">
        <div className="feature-index">
          <span className="mono-label">{String(order).padStart(2, '0')} / {TOTAL_FEATURES}</span>
          <span className="mono-label mono-dim">{t(`${chapterId}.num`)}</span>
        </div>
        <h3 className="feature-title">{t(`${feature.id}.title`)}</h3>
        <p className="feature-body">{t(`${feature.id}.body`)}</p>
      </div>
      <div className="feature-media">
        <DemoPlaceholder label={t(`${feature.id}.label`)} tc={feature.tc} />
      </div>
    </div>
  );
});

export default FeatureBlock;
