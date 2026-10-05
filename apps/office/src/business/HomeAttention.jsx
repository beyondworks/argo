// 홈 '챙길 것' 모듈(18차, 유건 결정 3 — 종 모양 알림함 대신) — 마감 지난 할 일·오늘 마감·결재 대기·입금 지연·계산서 미발행을 한곳에. 줄을 누르면 그 화면(거른 주소)으로.
// 할 일 수는 왼쪽 메뉴 배지와 같은 계산·같은 행(core/task-model.js dueCounts, core/tasks.js useTaskRows), 거래는 거래처 탭 '챙길 것'과 같은 계산(deal-model.js attentionOf).
// 읽기: 할 일은 이미 있는 저장소(현황 카드와 같은 읽기 — 30초 안 중복 없음), 결재는 화면 상태, 거래는 홈 업무 카드와 같은 읽기(업무 카드가 홈에 있으면 그 읽기를 같이 쓴다). 새 서버 함수·폴링 없음.
import { useEffect, useMemo, useState } from 'react';
import { t, registerDict } from '../core/i18n.js';
import { Link } from '../core/router.jsx';
import { Icon } from '../ui/Icon.jsx';
import { baseOf } from '../core/commands.js';
import { ME, getMode } from '../core/session.js';
import { useStore, approvalsIn } from '../core/store.js';
import { useTasks, useTaskRows, useTaskDay, loadTasks } from '../core/tasks.js';
import { cacheFresh } from '../core/refetch.js';
import { dueCounts } from '../core/task-model.js';
import { useViewTasks } from '../views/data.js';
import { useHomeBusiness } from './HomeModules.jsx';
import { useBusiness } from './data.js';
import { attentionOf, kstToday } from './deal-model.js';
import { attentionRows } from './attention-model.js';
import { ATTN_DICT } from './attention-i18n.js';

registerDict(ATTN_DICT);
const ICON = { overdue: 'todo', today: 'calendar', approvals: 'stamp', late: 'receipt', uninvoiced: 'deal' };

export default function HomeAttention({ space }) {
  const home = useHomeBusiness();
  return home ? <Body space={space} business={home.business} /> : <OwnBusiness space={space} />;
}
/** 업무 카드가 없는 홈 — 거래 읽기 하나만(업무 카드 묶음처럼 마케팅·기간 보고서까지 읽지 않는다).
 *  같은 계정·같은 공간이면 30초 안에 받은 것을 다시 쓴다(DB 위생, 검수 LOW 11 — 홈을 오갈 때마다 다시 읽지 않게). 예시 모드는 이 브라우저 안 데이터라 캐시하지 않는다 */
const bizCache = new Map(); // 공간 → { owner, at, data }
function OwnBusiness({ space }) {
  const [hit] = useState(() => (getMode() === 'signedIn' && cacheFresh(bizCache.get(space), { now: Date.now(), owner: ME.id }) ? bizCache.get(space) : null)); // 열 때 한 번만 판정
  return hit ? <Body space={space} business={{ data: hit.data, error: null }} /> : <FetchBusiness space={space} />;
}
function FetchBusiness({ space }) {
  const business = useBusiness(space);
  useEffect(() => { if (business.data && getMode() === 'signedIn') bizCache.set(space, { owner: ME.id, at: Date.now(), data: business.data }); }, [business.data, space]);
  return <Body space={space} business={business} />;
}

function Body({ space, business }) {
  // 모드는 앱이 뜰 때 정해지고 바뀌지 않는다(훅 순서가 흔들리지 않는다) — 로그인은 할 일 저장소를 읽게 하고, 예시 모드는 예시 할 일을 배지와 같은 자리에 넣는다
  const st = getMode() === 'sample' ? (useViewTasks(space), {}) : useTasks(space);
  const rows = useTaskRows(space), today = useTaskDay(); // 메뉴 배지와 같은 행·같은 날짜(자정 뒤 탭 복귀면 다시 계산)
  const all = useStore((s) => s.approvals);
  const approvals = useMemo(() => all.filter(approvalsIn(space)).length, [all, space]);
  const data = business.data, on = !!data?.settings?.enabled?.includes('customers'); // 거래처를 꺼 둔 공간은 입금·계산서 줄을 보이지 않는다(누르면 갈 곳이 없다)
  const biz = useMemo(() => (on ? attentionOf(data, kstToday()).counts : null), [on, data]);
  const { rows: items, pending, taskFail } = attentionRows({ due: dueCounts(rows, today, ME.id), dueError: !!st.error, approvals, biz, bizPending: !data && !business.error }, baseOf(space));
  return <>
    {items.map((x) => <Link key={x.key} to={x.to} className="mod-row">
      <Icon name={ICON[x.key]} size={14} className="dim" />
      <span className="mod-main"><span className="clamp">{t(`home.attn.${x.key}`)}</span></span>
      <span className={`badge ${x.tone}`}>{t('home.attn.n', { n: x.n })}</span>
    </Link>)}
    {!items.length && !taskFail && <div className="mod-empty" role="status">{t(pending ? 'home.attn.loading' : 'home.attn.none')}</div>}
    {taskFail && <div className="mod-empty" role="alert"><p>{t('home.attn.taskFail')}</p><button type="button" className="btn sm" onClick={() => loadTasks(space, true)}>{t('home.attn.retry')}</button></div>}
    {!data && business.error && <p className="dim small">{t('home.attn.bizFail')}</p>}
  </>;
}
