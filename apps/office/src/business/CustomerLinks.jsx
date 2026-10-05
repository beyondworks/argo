// 거래처 카드의 '일정'과 '이름이 들어간 할 일'(14차, 인트라넷 거래처 허브 '진행' 탭).
// 일정 = 일정의 거래처 칸으로 이 거래처에 연결된 것(달력 '거래처' 보기와 같은 읽기 창: 석 달 전 ~ 아홉 달 뒤, 같은 캐시라 다시 받지 않는다).
// 할 일 = 제목·메모에 거래처 이름이 든 것(할 일에는 거래처 칸이 없어 인트라넷처럼 이름으로 맞춘다). 할 일 목록은 읽기만 한다.
// 예시 모드는 일정 예시와 업무 예시의 거래처 id가 달라 이름으로 맞춘다(로그인 모드는 id로만 — 다른 조직의 같은 이름 거래처가 섞이지 않게).
import { useMemo } from 'react';
import { t } from '../core/i18n.js';
import { getMode } from '../core/session.js';
import { baseOf } from '../core/commands.js';
import { navigate } from '../core/router.jsx';
import { useEvents } from '../calendar/api.js';
import { kstDay, kstStart, windowOf, expand } from '../calendar/model.js';
import { inSpace, fmtDay, fmtTime } from '../calendar/shared.js';
import { useViewTasks } from '../views/data.js';
import { Icon } from '../ui/Icon.jsx';
import { tasksMentioning } from './deal-model.js';

const label = (key) => t(`bizui.${key}`);
const dayText = (day) => fmtDay(day, { month: 'short', day: 'numeric', weekday: 'short' });

export default function CustomerLinks({ space, customer }) {
  const today = kstDay(Date.now());
  const [from, to] = windowOf('customers', today);
  const data = useEvents(from, to);
  const sample = getMode() === 'sample';
  const occ = useMemo(() => {
    if (!data.events) return [];
    const here = space === 'me' ? data.events.filter((e) => !e.org_id) : inSpace(data.events, space); // 개인 거래처는 개인 일정에만 연결된다
    const mine = here.filter((e) => e.customer_id === customer.id || (sample && e.customer_name === customer.name));
    return expand(mine, kstStart(from), kstStart(to));
  }, [data.events, space, customer.id, customer.name, sample, from, to]);
  const now = Date.now();
  const upcoming = occ.filter((o) => o.end >= now).slice(0, 5), past = occ.filter((o) => o.end < now).slice(-3).reverse();
  const all = useViewTasks(space);
  const tasks = useMemo(() => tasksMentioning(all.filter((x) => x.space === space), customer.name)
    .sort((a, b) => !!a.done_at - !!b.done_at || String(a.due_on ?? '9999').localeCompare(String(b.due_on ?? '9999'))).slice(0, 8), [all, space, customer.name]);
  const openDay = (o) => navigate(`${baseOf(space)}/calendar?day=${kstDay(o.start)}`);
  const event = (o, dim) => <li key={o.key}><button type="button" className={`bizui-link${dim ? ' dim' : ''}`} onClick={() => openDay(o)}>{o.title || label('untitled')}</button>
    <span className="when mono">{dayText(kstDay(o.start))}{o.all_day ? '' : ` ${fmtTime(o.start)}`}</span></li>;
  return <>
    <h3>{label('card.events')} <span className="dim small">{label('card.eventsRange')}</span></h3>
    {data.loading && !data.events ? <p className="dim small card-empty">{label('card.loading')}</p>
      : data.error && !data.events ? <p className="dim small card-empty">{label('card.loadFail')}</p>
      : upcoming.length + past.length ? <ul className="card-deals card-links">{upcoming.map((o) => event(o, false))}
          {past.length > 0 && <li className="card-links-head dim small">{label('card.past')}</li>}{past.map((o) => event(o, true))}</ul>
      : <p className="dim small card-empty">{label('card.noEvents')}</p>}
    <h3>{label('card.tasks')} {tasks.length > 0 && <span className="dim small">{tasks.length}</span>}</h3>
    {tasks.length ? <ul className="card-deals card-links">{tasks.map((x) => <li key={x.id}>
      <span className={`grow${x.done_at ? ' dim' : ''}`}>{x.done_at && <Icon name="check" size={12} />} {x.title}</span>
      {x.done_at ? <span className="badge ok">{label('card.taskDone')}</span> : x.due_on && <span className="when mono">{dayText(x.due_on)}</span>}
    </li>)}</ul> : <p className="dim small card-empty">{label('card.noTasks')}</p>}
  </>;
}
