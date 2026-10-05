// 선택 막대(11차) — 하나 이상 고르면 화면 아래 가운데에 "N개 선택됨"과 그 화면의 일괄 동작. 모든 화면이 이 부품 하나를 쓴다(core/selection.js SelectionHost가 고른 것이 생길 때 받는다).
// 동작은 그 화면이 넘긴 것(useSelection actions) — 이미 있는 단일 동작을 여러 개에 적용하는 것만. 되돌릴 수 없는 동작은 그 화면의 확인 창을 거친다.
import { Icon } from './Icon.jsx';
import { registerDict, t, useLang } from '../core/i18n.js';
import { SELECT_DICT } from './select-i18n.js';
import { CELLS } from '../core/selection.js';
import { cellActions, setCells } from './marquee.js';
import { useHideAll } from '../core/hide-all.js';
import './selection.css';

registerDict(SELECT_DICT);

export default function SelectionBar({ id, scope }) {
  useLang();
  useHideAll(); // 전체 가리기를 켜고 끄면 동작 목록을 다시 만든다(가리기 중에는 쓰기 대신 안내, 2차 검수 LOW-A)
  const cells = id === '__cells'; // 칸 선택(12차) — 개수는 칸 수, 동작은 가리기·가림 해제
  if (!cells && !scope) return null;
  const keys = cells ? [...CELLS.keys] : [...scope.get()], clear = () => (cells ? setCells(new Set()) : scope.set(new Set()));
  if (!keys.length) return null;
  const acts = (cells ? cellActions(keys, clear) : scope.opts().actions?.(keys, clear) ?? []).filter(Boolean);
  const label = t(cells ? 'sel.cells' : 'sel.count', { n: keys.length });
  // vw-selbar = 셸(리퀴드·뉴모피즘)이 떠 있는 막대에 주는 모양(themes.css)을 그대로 받는다
  return <div className="sel-bar vw-selbar" role="toolbar" aria-label={label}>
    <strong>{label}</strong>
    {acts.map((a) => a.heading ? <span key={a.heading} className="dim small">{a.heading}</span> : <button key={a.label} type="button" className={`btn sm${a.danger ? ' danger-text' : ''}`} disabled={a.disabled} onClick={(e) => a.run(keys, clear, e)}>{a.icon && <Icon name={a.icon} size={13} />}{a.label}</button>)}
    <button type="button" className="icon-btn sm" aria-label={t('sel.clear')} title={t('sel.clear')} onClick={clear}><Icon name="x" size={14} /></button>
  </div>;
}
