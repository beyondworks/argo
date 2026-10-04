// 공유 링크 화면(로그인 없이 /f#<토큰>, 15차) — 서명 페이지(docs/SignPage.jsx)와 같은 모양: 가운데 카드 하나, 잠긴 상태는 아이콘·제목·설명.
// 토큰은 주소 조각(#)에서 읽는다 — 조각은 서버로 가지 않아 접근 기록에 남지 않는다(분리 검수 LOW-11). 서버에는 열기·내려받기 요청 본문으로만 보낸다(links.js).
// 파일 이름·크기·만료일과 내려받기 단추만 보인다. 내려받기는 누를 때마다 서버가 토큰을 다시 확인하고 5분짜리 서명 주소를 준다(links.js).
// 만료·끊김·지운 파일·없는 토큰은 모두 같은 '열 수 없는 링크'. 검색 노출 끔(noindex).
import { useEffect, useState, useSyncExternalStore } from 'react';
import '../docs/docs.css';
import './link.css';
import { t, useLang, getLang, registerDict } from '../core/i18n.js';
import { Icon } from '../ui/Icon.jsx';
import { fmtBytes } from '../core/files.js';
import { LINK_DICT } from './link-i18n.js';
import { openLink, downloadLink } from './links.js';
import { tokenFromHash } from './link-model.js';

registerDict(LINK_DICT);
const day = (iso) => new Date(iso).toLocaleDateString(getLang() === 'en' ? 'en-US' : 'ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' });

function Shell({ children }) {
  return <div className="sign-page"><div className="sign-wrap narrow">{children}<p className="dim small link-foot">{t('link.madeWith')}</p></div></div>;
}

const onHash = (fn) => { addEventListener('hashchange', fn); return () => removeEventListener('hashchange', fn); };

export default function LinkPage() {
  useLang();
  const token = useSyncExternalStore(onHash, () => tokenFromHash(location.hash), () => '');
  const [info, setInfo] = useState(undefined); // undefined 불러오는 중 | null 열 수 없음 | 'error' 잠시 뒤 | { name, size, … }
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const load = () => { setInfo(undefined); openLink(token).then(setInfo, (e) => setInfo(e?.code === 'gone' ? null : 'error')); };
  useEffect(() => {
    let m = document.querySelector('meta[name="robots"]');
    if (!m) { m = document.createElement('meta'); m.name = 'robots'; document.head.append(m); }
    m.content = 'noindex, nofollow';
    load();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = info && typeof info === 'object' ? info.name : t('link.title'); }, [info]);

  const get = async () => {
    setBusy(true); setErr('');
    try { await downloadLink(token); } catch (e) { if (e?.code === 'gone') setInfo(null); else setErr(t('link.err')); } finally { setBusy(false); }
  };
  if (info === undefined) return <Shell><p className="dim" role="status">{t('link.loading')}</p></Shell>;
  if (info === null) return <Shell><div className="sign-card sign-lock"><Icon name="lock" size={26} /><h1>{t('link.gone.title')}</h1><p className="dim">{t('link.gone.body')}</p></div></Shell>;
  if (info === 'error') return <Shell><div className="sign-card sign-lock"><Icon name="info" size={26} /><h1>{t('link.title')}</h1><p className="dim">{t('link.err')}</p><button type="button" className="btn" onClick={load}>{t('link.retry')}</button></div></Shell>;
  return <Shell>
    <p className="sign-brand">{t('link.title')}</p>
    <div className="sign-card">
      {info.org && <p className="dim small">{t('link.from', { org: info.org })}</p>}
      <h1 className="link-name"><Icon name="file" size={18} /><span>{info.name}</span></h1>
      <p className="dim small">{fmtBytes(info.size ?? 0)}{info.expiresAt ? ` · ${t('link.until', { date: day(info.expiresAt) })}` : ''}</p>
      <button type="button" className="btn primary" disabled={busy} onClick={get}><Icon name="download" size={14} />{busy ? t('link.preparing') : t('link.download')}</button>
      {err && <p className="bizui-error" role="alert">{err}</p>}
      <p className="dim small">{t('link.noLogin')}</p>
    </div>
  </Shell>;
}
