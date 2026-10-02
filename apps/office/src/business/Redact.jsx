// 부분 가림(유건 9/29) — 값 위에서 우클릭하면 가리기·가리기 해제. 가린 값은 먼지로 덮이고, 누르고 있는 동안만 잠깐 보인다.
// 인트라넷의 전체 가림(시머)과 같은 효과를 항목 단위로. 값 자체는 그대로 있고 화면에서만 덮는다.
// 잠깐 보기는 왼쪽 버튼만 — 우클릭의 누름에 반응하면 가림이 풀리며 칸이 줄어 우클릭 신호가 표 칸으로 빠져 메뉴가 안 떴다(유건 제보 9/29).
// 키보드: 값에 초점을 두고 메뉴 키(Shift+F10)로 메뉴, 가린 값은 Enter로 잠깐 보기(초점이 떠나면 다시 가림). 버튼 안에 있을 때는 focusable={false}.
import { useState } from 'react';
import { t, registerDict } from '../core/i18n.js';
import { openMenu } from '../ui/Menu.jsx';
import './redact.css';
import { REDACT_DICT } from './redact-i18n.js';

registerDict(REDACT_DICT); // 업무 화면 밖(회사 정보·직원 명부)에서도 쓰므로 쓰는 말은 여기서 등록한다

export function Redact({ on, onToggle, disabled, focusable = true, cell, picked, children }) {
  const [peek, setPeek] = useState(false);
  const menu = (event) => {
    if (disabled || !onToggle || picked) return; // 여러 칸을 고른 상태면 표가 한 번에 가리기 메뉴를 연다
    openMenu(event, [{ label: t(on ? 'bizui.unredact' : 'bizui.redact'), icon: on ? 'eye' : 'eyeOff', run: onToggle }]);
  };
  const hide = () => setPeek(false);
  const keys = focusable && onToggle && !disabled ? { tabIndex: 0, onBlur: hide, onKeyDown: (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { menu(event); return; } // 메뉴 키 — 브라우저 기본 우클릭 신호에 기대지 않는다
    if (on && event.key === 'Enter') { event.preventDefault(); setPeek((v) => !v); }
  } } : {};
  return <span className={`redact${on && !peek ? ' on' : ''}${picked ? ' picked' : ''}`} data-cell={cell} onContextMenu={menu} {...keys}
    {...(on ? { onPointerDown: (event) => { if (event.button === 0) setPeek(true); }, onPointerUp: hide, onPointerLeave: hide, onPointerCancel: hide, title: t('bizui.redactedHint') } : {})}>
    {on && !peek ? <><span className="sr-only">{t('bizui.redacted')}</span><span aria-hidden="true">{children}</span></> : children}
  </span>;
}
