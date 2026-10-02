// 부분 가림(유건 9/29) — 값 위에서 우클릭하면 가리기·가리기 해제. 가린 값은 먼지로 덮이고, 누르고 있는 동안만 잠깐 보인다.
// 인트라넷의 전체 가림(시머)과 같은 효과를 항목 단위로. 값 자체는 그대로 있고 화면에서만 덮는다.
// 잠깐 보기는 왼쪽 버튼만 — 우클릭의 누름에 반응하면 가림이 풀리며 칸이 줄어 우클릭 신호가 표 칸으로 빠져 메뉴가 안 떴다(유건 제보 9/29).
// 키보드: 값에 초점을 두고 메뉴 키(Shift+F10)로 메뉴, 가린 값은 Enter로 잠깐 보기(초점이 떠나면 다시 가림). 버튼 안에 있을 때는 focusable={false}.
import { useEffect, useRef, useState } from 'react';
import { t, registerDict } from '../core/i18n.js';
import { openMenu } from '../ui/Menu.jsx';
import './redact.css';
import { REDACT_DICT } from './redact-i18n.js';
import { redactHandlers, CELL_REG } from './cell-pick.js';
import { isHidden, setHidden, useRedactStore } from './redact-store.js';

registerDict(REDACT_DICT); // 업무 화면 밖(회사 정보·직원 명부)에서도 쓰므로 쓰는 말은 여기서 등록한다

// 입자 효과(12차 추가 2, 참고 영상 refs10/shimmer.mov — 텔레그램 스포일러 계열)는 가림이 처음 보일 때 받는다(ui/dust.js — 루프 하나로 화면에 보이는 가림만 그린다)
let dustP = null, dustM = null;
const dust = () => (dustP ??= import('../ui/dust.js').then((m) => (dustM = m), (e) => { dustP = null; throw e; }));

/** 값 하나 가림. cellKey = 칸 고르기(12차)로 여러 칸을 한 번에 가릴 때 쓰는 칸 이름(그 화면에서 하나뿐) — batch·item = 같은 쓰기를 한 번에 보낼 때(거래처 표 redact.bulk) */
export function Redact({ on, onToggle, disabled, focusable = true, cellKey, batch, item, defer, children }) {
  const [peek, setPeek] = useState(false);
  const el = useRef(null), live = useRef(null), hidden = !!on && !peek;
  live.current = { on: !!on, onToggle, batch, item };
  // 칸 목록 — 선택 막대·우클릭이 고른 칸 여러 개를 한 번에 가리고 풀 때 이 칸의 저장 방식(onToggle·batch)을 쓴다
  useEffect(() => {
    if (!cellKey || !onToggle || disabled) return undefined;
    const c = { on: () => live.current.on, set: (v) => { if (live.current.on !== v) live.current.onToggle?.(); }, get batch() { return live.current.batch; }, get item() { return live.current.item; } };
    CELL_REG.set(cellKey, c);
    return () => { if (CELL_REG.get(cellKey) === c) CELL_REG.delete(cellKey); };
  }, [cellKey, !!onToggle, disabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const node = el.current; if (node && (hidden || dustM)) dust().then((m) => m.show(node, hidden), () => {}); }, [hidden]);
  useEffect(() => () => dustM?.drop(el.current), []);
  // defer = 이 값이 든 행을 여러 개 고른 상태(11차) — 우클릭은 목록이 고른 행 전체 메뉴로 받는다. 고른 칸 위(data-cell-on)면 선택 상자가 고른 칸 전체 메뉴를 연다
  const handlers = redactHandlers({ on, onToggle, disabled, focusable, defer }, setPeek, (event, items) => { if (!event.currentTarget?.hasAttribute?.('data-cell-on')) openMenu(event, items.map((x) => ({ ...x, label: t(x.label) }))); });
  return <span ref={el} className={`redact${hidden ? ' on' : ''}`} data-sel-cell={cellKey} {...handlers} {...(on ? { title: t('bizui.redactedHint') } : {})}>
    {hidden && <span className="sr-only">{t('bizui.redacted')}</span>}
    <span className="redact-v" aria-hidden={hidden || undefined}>{children}</span>
  </span>;
}

/** 저장 자리가 따로 없는 값(금액·이메일·전화 등)의 가림 — 내 화면 가림(redact-store.js). k = 칸 이름(예: 'item:<id>:price') */
const hideBatch = (items) => { setHidden(items.filter((x) => x.on).map((x) => x.k), true); setHidden(items.filter((x) => !x.on).map((x) => x.k), false); };
export function Hide({ k, focusable, children }) {
  useRedactStore();
  return <Redact on={isHidden(k)} cellKey={k} focusable={focusable} batch={hideBatch} item={{ k }} onToggle={() => setHidden([k], !isHidden(k))}>{children}</Redact>;
}
