// 거래 품목 줄 입력 — 거래 만들기·거래 수정 창이 같이 쓴다(14차). 상품·서비스, 수량, 단가, 과세 구분과 합계(공급가액·세액·부가세 포함).
// locked(line) = 재고 기록이 걸린 줄: 빼거나 다른 품목으로 바꿀 수 없다(서버 business_line_in_use). 수량·단가·과세 구분은 고칠 수 있다.
import { t, getLang } from '../core/i18n.js';
import { vatOf } from './deal-model.js';

const label = (key) => t(`bizui.${key}`);
const money = (amount) => new Intl.NumberFormat(getLang() === 'en' ? 'en-US' : 'ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(amount || 0));
const Field = ({ name, children }) => <label className="field-block bizui-field"><span className="label">{label(name)}</span>{children}</label>;

export function OrderLines({ lines, onChange, items, busy, locked = () => false }) {
  return <>
    {lines.map((line, index) => {
      const update = (patch) => onChange(lines.map((row, i) => (i === index ? { ...row, ...patch, keepVat: false } : row))); // 고친 줄은 세액을 다시 계산해 보여 준다
      const fixed = locked(line);
      return <fieldset className="bizui-order-line" key={line.id ?? `new:${index}`}><legend>{label('line')} {index + 1}</legend>
        <Field name="catalog"><select className="input" required value={line.item_id} disabled={busy || fixed} title={fixed ? label('lineInUse') : undefined} onChange={(event) => { const item = items.find((row) => row.id === event.target.value); update({ item_id: event.target.value, unit_price: item?.price ?? 0 }); }}><option value="">{label('choose')}</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {label(item.kind)}</option>)}</select></Field>
        <Field name="quantity"><input className="input" type="number" min="1" max="1000000" step="1" required value={line.quantity} onChange={(event) => update({ quantity: event.target.value })} /></Field>
        <Field name="price"><input className="input" type="number" min="0" max="1000000000000" step="1" required value={line.unit_price} onChange={(event) => update({ unit_price: event.target.value })} /></Field>
        <Field name="taxType"><select className="input" value={line.tax_type ?? 'taxable'} onChange={(event) => update({ tax_type: event.target.value })}>{['taxable', 'zero', 'exempt'].map((key) => <option key={key} value={key}>{label(`tax.${key}`)}</option>)}</select></Field>
        <button className="btn" type="button" disabled={lines.length === 1 || busy || fixed} title={fixed ? label('lineInUse') : undefined} onClick={() => onChange(lines.filter((_, i) => i !== index))}>{label('removeLine')}</button>
      </fieldset>;
    })}
    <button className="btn" type="button" disabled={busy || lines.length >= 100} onClick={() => onChange([...lines, { item_id: '', quantity: 1, unit_price: 0 }])}>{label('addLine')}</button>
    <LinesTotal lines={lines} />
  </>;
}

/** 합계 줄 — 공급가액 · 세액, 부가세 포함 합계(고치지 않은 줄은 저장된 세액을 그대로 쓴다) */
export function LinesTotal({ lines }) {
  const supply = lines.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price), 0);
  const vat = lines.reduce((sum, line) => sum + (line.vat != null && line.keepVat ? Number(line.vat) : vatOf(Number(line.quantity) * Number(line.unit_price), line.tax_type ?? 'taxable')), 0);
  return <div className="bizui-total"><span className="dim">{label('supply')} {money(supply)} · {label('vat')} {money(vat)}</span><strong>{money(supply + vat)}</strong></div>;
}
