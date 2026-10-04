// 거래처 탭 위 '챙길 것' 카드(14차, 인트라넷 거래처 화면 '해야 할 일'·'입금 지연' 카드) — 계산서 미발행·사업자등록증 미보유·입금 지연.
// 누르면 거래처 목록을 그 거래처만으로 거른다(다시 누르면 풀린다). 사업자등록증은 문서함 목록에서 판정한다(문서함 화면과 같은 목록·같은 판정 missingBizcert).
// 부하: 문서함 목록은 공간마다 한 번 읽어 화면 메모리에 둔다(문서함 화면과 같은 캐시) — 새 주기 호출·폴링 없음.
import { useEffect, useMemo } from 'react';
import { t } from '../core/i18n.js';
import { useFiles } from '../files/api.js';
import { missingBizcert } from '../files/model.js';

const label = (key) => t(`bizui.${key}`);

export default function CustomerAttention({ space, data, attention, view, onView, onMissing }) {
  const files = useFiles(space);
  const live = useMemo(() => data.customers.filter((c) => !c.archived_at), [data.customers]);
  const missing = useMemo(() => (files.files ? new Set(missingBizcert(live, files.files).map((c) => c.id)) : null), [files.files, live]);
  useEffect(() => { onMissing(missing); }, [missing, onMissing]);
  const items = [
    { key: 'uninvoiced', n: attention.counts.uninvoiced, unit: 'deals', tone: 'warn' },
    { key: 'nobizcert', n: missing?.size ?? null, unit: 'places', tone: 'warn', wait: !missing && !files.error, broken: !missing && !!files.error },
    { key: 'overdue', n: attention.counts.overdue, unit: 'deals', tone: 'danger' },
  ];
  return <section className="biz-attn" aria-label={label('attn.title')}>
    <h2>{label('attn.title')}</h2>
    <div className="biz-attn-items">{items.map((x) => {
      const on = view === x.key;
      return <button key={x.key} type="button" className={`biz-attn-item${on ? ' on' : ''}`} aria-pressed={on} disabled={!on && !x.n} onClick={() => onView(on ? 'all' : x.key)}>
        <span className="name">{label(`attn.${x.key}`)}</span>
        {x.wait ? <span className="dim">…</span> : x.broken ? <span className="dim" title={t(files.error)}>—</span>
          : <span className={`badge${x.n ? ` ${x.tone}` : ''}`}>{t(`bizui.attn.${x.unit}`, { n: x.n })}</span>}
        <span className="hint">{label(`attn.${x.key}Hint`)}</span>
      </button>;
    })}</div>
    {files.more && <p className="dim small">{label('attn.partial')}</p>}
  </section>;
}
