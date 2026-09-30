// 홈 '다가오는 일정' 모듈 — 앞으로 7일, 최대 6건. 누르면 그날의 달력으로. 달력 화면과 같은 읽기 창 캐시를 쓴다.
import { useMemo } from 'react';
import { t, registerDict, useLang } from '../core/i18n.js';
import { Link } from '../core/router.jsx';
import { baseOf } from '../core/commands.js';
import { Face } from '../ui/Face.jsx';
import * as M from './model.js';
import { useEvents } from './api.js';
import { inSpace, calOf, colorOf, spaceOfOrg, fmtDay, fmtTime, pref } from './shared.js';
import { CAL_DICT } from './calendar-i18n.js';

registerDict(CAL_DICT);

export default function Upcoming({ space }) {
  useLang();
  const today = M.kstDay(Date.now()), to = M.addDays(today, 8);
  const { events, error } = useEvents(today, to);
  const list = useMemo(() => {
    if (!events) return null;
    const off = new Set(pref(`off:${space}`, [])), now = Date.now(), end = M.kstStart(M.addDays(today, 7));
    return M.expand(inSpace(events, space), now, end).filter((o) => !off.has(calOf(o, space))).slice(0, 6);
  }, [events, space, today]);
  if (!list) return <div className="mod-empty" role="status">{error ? t(error) : t('cal.loading')}</div>;
  if (!list.length) return <div className="mod-empty">{t('cal.upcomingEmpty')}</div>;
  const color = pref('color', 'category');
  return list.map((o) => {
    const day = M.spanOf(o)[0];
    const when = `${fmtDay(day, { month: 'short', day: 'numeric', weekday: 'short' })} · ${o.all_day ? t('cal.allDay') : fmtTime(o.start)}`;
    return (
      <Link key={o.key} to={`${baseOf(space)}/calendar?day=${day}`} className="mod-row">
        <span className="dot" style={{ background: colorOf(o, color) ?? 'var(--fg-3)' }} />
        <span className="mod-main"><span className="clamp">{o.title}</span><small>{[when, space === 'me' && (o.org_id ? spaceOfOrg(o.org_id)?.name : t('cal.cal.me')), o.location].filter(Boolean).join(' · ')}</small></span>
        {o.crew && <Face id={o.crew} size={18} />}
      </Link>
    );
  });
}
