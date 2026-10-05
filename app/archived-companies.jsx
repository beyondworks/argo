'use client';
// 보관한 회사 — 목록과 되돌리기(F14). 되돌리면 원래 자리로 돌아와 홈 목록에 다시 보인다. 보관 마커(tombstone)는 동기화가 철회한다
// (src/workspace.mjs restoreArchivedCompany 주석). 다른 기기에서도 보관한 상태면 그 기기에서도 되돌려야 해 안내에 적는다.
// 설정(위험 구역)과 홈이 같은 카드를 쓴다 — 회사가 하나뿐인 사용자가 보관하면 설정이 사라져 되돌릴 길이 없던 것(UM3, 2026-10-05).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Spinner, Skeleton, api } from './ui';
import { useLang } from './i18n';
import { restoreFailKind, archivedRowState } from './lib/archived-view.mjs';

/** onRestored — 되돌리기에 성공했을 때(홈이 회사 목록을 다시 읽는다). existingIds — 지금 목록에 있는 회사 id들(같은 id가 이미 있으면 되돌리기 대신 열기). */
export default function ArchivedCompaniesCard({ onRestored, existingIds, onLoaded }) {
  const { t, lang } = useLang();
  const [items, setItems] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [blocked, setBlocked] = useState(() => new Set()); // 방금 409(이미 같은 회사가 있음)를 받은 archiveId — 같은 실패를 반복하지 않게 열기로 바꾼다(UL1)
  const [msg, setMsg] = useState(null); // { ok, text, href? }
  // 부모가 매 렌더 새 함수를 넘겨도 다시 불러오지 않게 최신 콜백만 ref로 들고 load는 고정한다(안 그러면 렌더마다 목록 요청이 반복된다)
  const cb = useRef({ onLoaded, onRestored });
  cb.current = { onLoaded, onRestored };
  const load = useCallback(() => {
    setFailed(false);
    api('/api/archived-companies').then((d) => { setItems(d.items ?? []); cb.current.onLoaded?.(d.items ?? []); }).catch(() => { setItems(null); setFailed(true); });
  }, []);
  useEffect(load, [load]);
  async function restore(it) {
    if (busy) return;
    setBusy(it.archiveId); setMsg(null);
    try {
      const r = await api('/api/archived-companies', { archiveId: it.archiveId });
      setMsg({ ok: true, text: t('settings.archived.restored', { name: it.name }), href: `/c/${r.wsId}` });
      cb.current.onRestored?.(r.wsId);
      load();
    } catch (e) {
      if (restoreFailKind(e) === 'exists') {
        setBlocked((cur) => new Set(cur).add(it.archiveId));
        setMsg({ ok: false, text: String(e?.message || t('settings.archived.exists')), href: `/c/${it.wsId}` });
      } else setMsg({ ok: false, text: String(e?.message || t('settings.archived.restoreFail')) });
    } finally { setBusy(''); }
  }
  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="card-title">{t('settings.archived.title')}{items?.length ? ` · ${items.length}` : ''}</span>
      <p style={{ fontSize: 12.5, color: 'var(--fg-2)', margin: 0, lineHeight: 1.6 }}>{t('settings.archived.desc')}</p>
      {failed ? (
        <span role="alert" style={{ fontSize: 12.5, color: 'var(--danger)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {t('settings.archived.loadFail')}
          <button type="button" className="btn sm" onClick={load}>{t('common.retry')}</button>
        </span>
      ) : items === null ? <Skeleton h={40} /> : items.length === 0 ? (
        <span style={{ fontSize: 12.5, color: 'var(--fg-3)' }}>{t('settings.archived.empty')}</span>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map((it) => {
            const exists = archivedRowState(it, { blocked, existingIds }) === 'exists';
            return (
              <div key={it.archiveId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', border: '1px solid var(--border-soft)', borderRadius: 10, minWidth: 0 }}>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                  <span className="nav-sub">{exists ? t('settings.archived.exists') : t('settings.archived.when', { date: new Date(it.archivedAt).toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US') })}</span>
                </span>
                {exists ? (
                  <a className="btn sm" style={{ flex: 'none' }} href={`/c/${it.wsId}`}>{t('settings.archived.open')}</a>
                ) : (
                  <button type="button" className="btn sm" style={{ flex: 'none' }} disabled={!!busy} onClick={() => restore(it)}>
                    {busy === it.archiveId ? <Spinner size={11} /> : t('settings.archived.restore')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} style={{ margin: 0, fontSize: 12, color: msg.ok ? 'var(--fg-2)' : 'var(--danger)' }}>
          {msg.text}{msg.href && <> <Link href={msg.href} style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>{t('settings.archived.open')}</Link></>}
        </p>
      )}
    </div>
  );
}
