// 브리핑 화면(유건 10/5) — 나에게 온 브리핑과 내가 속한 조직의 전체 브리핑이 내 공간에 모인다. 누르면 오른쪽 창에서 읽는다(?open=id).
// 읽기 전용 — 본문 고치기는 없고, 지우기만(받은 사람 본인, 조직 전체 글은 그 조직 관리자 — 서버가 판단한다).
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.jsx';
import { Sheet } from '../ui/Panel.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { Markdown } from '../ui/Markdown.jsx';
import { t, ago, useLang, registerDict } from '../core/i18n.js';
import { navigate } from '../core/router.jsx';
import { listBriefings, getBriefing, deleteBriefing } from '../core/briefings.js';
import { BRIEFINGS_DICT } from './briefings-i18n.js';
import './briefings.css';

registerDict(BRIEFINGS_DICT);

const PAGE = 30;
const errText = (e) => t(e?.message?.includes('briefing_missing') ? 'brief.err.missing' : e?.message?.includes('briefing_forbidden') || e?.code === '42501' ? 'brief.err.forbidden' : 'brief.err.load');
/** 카드 아래 한 줄 — 어느 조직에서 왔는지(조직 전체면 그 표시), 종류, 쓴 에이전트, 언제 */
/** 목록 미리보기 — 마크다운 기호(#·-·[ ]·>·|·*)를 빼고 글자만 */
const plain = (s = '') => s.replace(/\[[ xX]\]|[#>*`|_~]+|-{3,}|(^|\s)-(?=\s)/g, ' ').replace(/\s+/g, ' ').trim();
export const briefMeta = (b) => [b.org_wide ? `${b.org_name} · ${t('brief.orgWide')}` : b.org_name ?? t('brief.personal'), t(`brief.kind.${b.kind}`), b.period, b.author_name, ago(b.created_at)].filter(Boolean).join(' · ');

export default function Briefings({ openId }) {
  useLang();
  const [rows, setRows] = useState(null);       // null = 첫 읽기 중
  const [more, setMore] = useState(false);      // 다음 30건이 있을 수 있다
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const seq = useRef(0);                        // 늦게 온 응답(앞 검색어)이 새 결과를 덮지 않게
  useEffect(() => { const id = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(id); }, [q]);

  const load = async (cursor) => {
    const n = ++seq.current;
    setBusy(true); setError(null);
    try {
      const got = await listBriefings({ cursor, q: term, limit: PAGE });
      if (n !== seq.current) return;
      setRows((prev) => (cursor ? [...(prev ?? []), ...got] : got)); setMore(got.length === PAGE);
    } catch (e) { if (n === seq.current) setError(e); }
    finally { if (n === seq.current) setBusy(false); }
  };
  useEffect(() => { setRows(null); load(null); }, [term]); // eslint-disable-line react-hooks/exhaustive-deps

  const [cur, setCur] = useState(null);         // 열어 둔 글(본문 포함)
  const [curError, setCurError] = useState(null);
  useEffect(() => {
    let live = true;
    setCur(null); setCurError(null);
    if (openId) getBriefing(openId).then((b) => live && setCur(b)).catch((e) => live && setCurError(e));
    return () => { live = false; };
  }, [openId]);
  const close = () => navigate(location.pathname);
  const [asking, setAsking] = useState(false);
  const remove = async () => {
    setAsking(false);
    try { await deleteBriefing(cur.id); setRows((r) => r?.filter((b) => b.id !== cur.id) ?? r); close(); showToast(t('brief.deleted')); }
    catch (e) { showToast(errText(e)); }
  };

  return (
    <div className="page-wrap">
      <div className="page-title-row"><div><h1 className="page-h1">{t('nav.briefings')}</h1><p className="dim">{t('brief.sub')}</p></div></div>
      <div className="docs-find"><Icon name="search" size={14} className="dim" /><input className="input" type="search" value={q} placeholder={t('brief.search')} aria-label={t('brief.search')}
        onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ(''); } }} /></div>
      {error && !rows?.length ? <LoadFail text={t('brief.err.load')} onRetry={() => load(null)} />
        : rows === null ? <div className="skeleton-lines" aria-busy="true"><span /><span /><span /></div>
        : !rows.length ? <div className="empty-state"><Icon name="text" size={20} /><p>{t(term ? 'brief.noMatch' : 'brief.empty')}</p></div>
        : <div className="list brief-list">{rows.map((b) => (
          <button key={b.id} type="button" className={`list-row top${b.id === openId ? ' on' : ''}`} onClick={() => navigate(`${location.pathname}?open=${b.id}`)}>
            <Icon name={b.org_wide ? 'building' : 'text'} size={14} className="dim" />
            <span className="grow brief-main"><span className="clamp">{b.title}</span><small className="dim clamp">{plain(b.excerpt)}</small><small className="dim">{briefMeta(b)}</small></span>
          </button>))}
        </div>}
      {rows?.length > 0 && error && <LoadFail small onRetry={() => load(rows.at(-1))} />}
      {rows?.length > 0 && more && !error && <button type="button" className="btn sm brief-more" disabled={busy} onClick={() => load(rows.at(-1))}>{t(busy ? 'brief.loading' : 'brief.more')}</button>}
      <Sheet open={!!openId} onClose={close} title={cur?.title ?? ''}>
        <div className="doc-read">
          {curError ? <p className="dim">{errText(curError)}</p>
            : !cur ? <div className="skeleton-lines"><span /><span /></div>
            : <>
              <p className="dim small">{briefMeta(cur)}</p>
              <Markdown text={cur.body} className="doc-md" />
              <div className="brief-actions"><button type="button" className="btn sm" onClick={() => setAsking(true)}><Icon name="trash" size={14} />{t('brief.delete')}</button></div>
            </>}
        </div>
      </Sheet>
      <Modal open={asking} title={t('brief.deleteTitle')} onClose={() => setAsking(false)}
        footer={<><button type="button" className="btn" onClick={() => setAsking(false)}>{t('cancel')}</button><button type="button" className="btn danger" onClick={remove}>{t('brief.delete')}</button></>}>
        <p>{t(cur?.org_wide ? 'brief.deleteOrgBody' : 'brief.deleteBody')}</p>
      </Modal>
    </div>
  );
}
