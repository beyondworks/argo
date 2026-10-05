// 홈 '브리핑' 모듈 — 나에게 온 최신 브리핑 1건(인트라넷 홈 위젯과 같은 자리). 모듈을 그릴 때 1회 읽기, 폴링 없음.
// 첫 화면 묶음에 넣지 않으려고 modules.jsx가 지연 로드한다. 전체는 머리의 링크(/briefings)로.
import { useEffect, useState } from 'react';
import { Markdown } from '../ui/Markdown.jsx';
import { LoadFail } from '../ui/LoadFail.jsx';
import { Link } from '../core/router.jsx';
import { t, useLang, registerDict } from '../core/i18n.js';
import { listBriefings } from '../core/briefings.js';
import { BRIEFINGS_DICT } from './briefings-i18n.js';
import './briefings.css';
import { briefMeta } from './Briefings.jsx';

registerDict(BRIEFINGS_DICT);

export default function BriefingModule() {
  useLang();
  const [state, setState] = useState({ b: undefined, error: false });
  const load = () => { setState({ b: undefined, error: false }); listBriefings({ limit: 1, body: true }).then((r) => setState({ b: r[0] ?? null, error: false })).catch(() => setState({ b: undefined, error: true })); };
  useEffect(load, []);
  if (state.error) return <LoadFail small onRetry={load} />;
  if (state.b === undefined) return <div className="mod-empty" role="status">{t('brief.loading')}</div>;
  if (!state.b) return <div className="mod-empty">{t('brief.empty')}</div>;
  const b = state.b;
  return <>
    <Link to={`/me/briefings?open=${b.id}`} className="mod-row top"><span className="mod-main"><span className="clamp">{b.title}</span><small>{briefMeta(b)}</small></span></Link>
    <div className="brief-mod-body"><Markdown text={b.body} className="doc-md" /></div>
  </>;
}
