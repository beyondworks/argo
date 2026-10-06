// 세그먼트 토글 하나(5차 피드백 3, 유건 2026-10-02) — 앱의 모든 분절 컨트롤이 이 컴포넌트를 쓴다(test/seg.test.mjs가 손으로 짠 마크업을 막는다).
// 모양·크기는 styles.css의 '.msgr-seg' 한 곳: 트랙 32px·알약 28px·글자 13px. 폰은 버튼 위아래 투명 테두리로 누르는 영역 44px, 넘치면 가로 스크롤.
// 바깥 클래스는 msgr-seg 그대로 — 화면별 배치 규칙(.msgr-top .msgr-seg 등)은 그대로 걸린다.
// options: [{ v, label, icon?, n?, disabled?, title?, aria? }] · kind: 'radio'(고르기, 기본) | 'tab'(탭)
// JSX 없이 쓴다 — node 시험이 바로 읽는다.
import { createElement as h } from 'react';

export function Seg({ label, value, options, onPick, kind = 'radio', className = '', disabled = false, ref = undefined }) {
  const tab = kind === 'tab';
  return h('div', { ref, className: className ? `msgr-seg ${className}` : 'msgr-seg', role: tab ? 'tablist' : 'radiogroup', 'aria-label': label },
    options.map((o) => {
      const on = o.v === value;
      return h('button', {
        key: String(o.v), type: 'button', role: tab ? 'tab' : 'radio',
        ...(tab ? { 'aria-selected': on } : { 'aria-checked': on }),
        className: on ? 'active' : undefined, disabled: disabled || !!o.disabled || undefined, title: o.title, 'aria-label': o.aria,
        onClick: () => onPick(o.v),
      }, o.icon ?? null, o.label, o.n != null ? h('span', { className: 'n' }, o.n) : null);
    }));
}
