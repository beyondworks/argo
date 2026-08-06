'use client';

import { useLang } from '@/lib/i18n';

// Q&A — 컨텍트 아래(유건 지시 2026-08-06). 출처: 인앱 피드백 76건의 빈번 클러스터
// (read-only/작업폴더·러너 연결·데이터 위치·결제/체험·메신저) + 제품 문서. 셀프 커스터마이즈
// (GitHub 클론 + 코딩 에이전트) 안내 포함. 네이티브 <details>로 JS 없이 접고 편다.
const ITEMS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'];

export default function FaqSection() {
  const { t } = useLang();
  return (
    <section className="faq-section" id="faq">
      <div className="faq-head">
        <span className="mono-label">{t('faq.kicker')}</span>
      </div>
      <h2 className="faq-title">{t('faq.title')}</h2>
      <div className="faq-list">
        {ITEMS.map((q) => (
          <details key={q} className="faq-item">
            <summary>{t(`faq.${q}`)}</summary>
            <p>{t(`faq.a${q.slice(1)}`)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
