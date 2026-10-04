// 파일 상세의 '공유 링크' 칸(15차) — 열려 있는 링크 목록, 링크 만들기(주소는 그때 한 번만 보인다), 링크 끊기.
// 메일 큰 첨부로 만든 링크도 여기에 '메일' 표시와 함께 보인다. 만들기·끊기는 올린 사람·관리자(내 공간은 본인) — 서버 office_file_link_write가 판정한다.
import { useEffect, useState } from 'react';
import { t, getLang, registerDict } from '../core/i18n.js';
import { Icon } from '../ui/Icon.jsx';
import { Modal, showToast } from '../ui/Overlay.jsx';
import { LINK_DICT } from './link-i18n.js';
import { createLink, revokeLink, listLinks, linkDaysLeft, LINK_DAYS } from './links.js';
import { fileError } from './api.js';
import './link.css';

registerDict(LINK_DICT);
const day = (iso) => new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', month: 'short', day: 'numeric' });

export function ShareLinks({ space, file }) {
  const [data, setData] = useState(null), [made, setMade] = useState(null), [busy, setBusy] = useState(false), [ask, setAsk] = useState(null); // ask: 끊을 링크 id(받은 사람 쪽에서는 되돌릴 수 없어 한 번 묻는다)
  // 목록을 못 받으면 '불러오지 못했습니다'와 다시 시도 — 권한 없음 안내와 섞지 않는다(분리 검수 LOW-9: 실패가 '만들 권한 없음'으로 보였다)
  const load = () => listLinks(space, file.id).then(setData, () => setData({ can: false, links: [], error: true }));
  const retry = async () => { setBusy(true); try { await load(); } finally { setBusy(false); } };
  useEffect(() => { setMade(null); load(); }, [space, file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const fail = (e) => showToast(t(fileError(e)));
  const make = async () => {
    setBusy(true);
    try { const r = await createLink(space, file, { days: LINK_DAYS }); setMade(r); showToast(t('link.made')); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const cut = async (id) => { try { await revokeLink(space, id); showToast(t('link.cutDone')); if (made?.id === id) setMade(null); await load(); } catch (e) { fail(e); } };
  const copy = async (url) => { try { await navigator.clipboard.writeText(url); showToast(t('link.copied')); } catch { /* 복사 권한 없음 — 주소는 화면에 그대로 있다 */ } };
  if (!data) return null;
  return <section className="files-links" aria-label={t('link.head')}>
    <p className="label">{t('link.head')}</p>
    <p className="dim small">{t('link.help', { days: LINK_DAYS })}</p>
    {made && <div className="files-links-new" role="status">
      <div className="url-row"><a href={made.url} target="_blank" rel="noopener noreferrer">{made.url}</a><button type="button" className="btn sm" onClick={() => copy(made.url)}><Icon name="copy" size={13} />{t('link.copy')}</button></div>
      <p className="dim small">{t('link.once')}</p>
    </div>}
    {data.error ? <div className="files-links-fail" role="alert"><span className="dim small grow">{t('link.loadFailed')}</span>
      <button type="button" className="btn sm" disabled={busy} onClick={retry}><Icon name="refresh" size={13} />{t('link.retry')}</button></div>
    : <>{data.links.length === 0 ? <p className="dim small">{t('link.none')}</p> : data.links.map((l) => <div key={l.id} className="files-links-row">
      <Icon name="link" size={13} className="dim" />
      <span className="grow">{t('link.row', { made: day(l.created_at), left: linkDaysLeft(l.expires_at) })}</span>
      {l.source === 'mail' && <span className="badge">{t('link.fromMail')}</span>}
      {(data.can || l.mine) && <button type="button" className="btn sm ghost" onClick={() => setAsk(l.id)}>{t('link.cut')}</button>}
    </div>)}
    {data.can ? <div><button type="button" className="btn sm" disabled={busy} onClick={make}><Icon name="link" size={13} />{t('link.make')}</button></div>
      : <p className="dim small">{t('link.noRight')}</p>}</>}
    <Modal open={!!ask} onClose={() => setAsk(null)} title={t('link.cutAsk')}
      footer={<><button type="button" className="btn" onClick={() => setAsk(null)}>{t('cancel')}</button><button type="button" className="btn danger" onClick={() => { const id = ask; setAsk(null); cut(id); }}>{t('link.cut')}</button></>}>
      <p>{t('link.cutBody')}</p>
    </Modal>
  </section>;
}
