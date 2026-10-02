'use client';
// 바깥 글 카드 — 출처 줄 + 앞 2줄 플레인 텍스트, 오른쪽 아래 ▾로 전체 원문을 펼치고 접는다(처음엔 접힘).
// 판정·요약은 inbound-card.mjs(순수 함수). 사장 말풍선(우측)과 구분해 좌측 중립 카드로 둔다 —
// who:'user'는 러너 프롬프트 관점의 역할일 뿐 사장이 쓴 글이 아니다(신고 2026-07-28 "내가 쓴 게 아니거든").
import { useMemo, useState } from 'react';
import { useLang } from '../../../../i18n';
import { inboundCard, plainPreview, sourceLine } from './inbound-card.mjs';

export function InboundCard({ m }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const card = useMemo(() => inboundCard(m), [m]);
  const preview = useMemo(() => (card ? plainPreview(card.body) : null), [card]);
  if (!card) return null;
  return (
    <div className="card fade-up" data-inbound={card.kind}
      style={{ alignSelf: 'flex-start', maxWidth: '85%', minWidth: 0, padding: '9px 8px 8px 13px', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 6, rowGap: 3 }}>
      {/* microlabel 금지 — 대문자 변환이 영문 이름·채널명을 왜곡한다(기억 그래프·폴백 표지와 같은 함정) */}
      <span title={t('chat.via.hint')} style={{ gridColumn: '1 / -1', fontSize: 11.5, color: 'var(--fg-3)', overflowWrap: 'anywhere', paddingRight: 5 }}>
        {sourceLine(card, t)}
      </span>
      {open ? (
        <div style={{ gridColumn: '1 / -1', fontSize: 12.5, color: 'var(--fg)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, paddingRight: 5 }}>{m.text}</div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--fg-2)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55 }}>{preview.text}</div>
      )}
      <button type="button" aria-expanded={open}
        aria-label={t(open ? 'chat.inbound.collapse' : 'chat.inbound.expand')} title={t(open ? 'chat.inbound.collapse' : 'chat.inbound.expand')}
        onClick={() => setOpen((v) => !v)}
        style={{ gridColumn: open ? '1 / -1' : 'auto', justifySelf: 'end', alignSelf: 'end', width: 24, height: 22, padding: 0, border: 0, borderRadius: 6,
          background: 'transparent', color: 'var(--fg-3)', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>
        <span aria-hidden="true" style={{ display: 'inline-block', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }}>▾</span>
      </button>
    </div>
  );
}
