// 크루 화면(17차 A) — 조직도 묶기, 크루별 맡은 일, 크루 상세에 모을 기록. 화면과 분리한 순수 함수(테스트: test/crew-model.test.mjs).
// 데이터는 기록판(board.js mapBoard)이 이미 만든 모양 그대로 쓴다 — 새 서버 호출·칸은 없다. 기록판에 없는 값(파견 여부·마지막 접속)은 만들지 않는다.
import { isMine, usable } from './crew-list.js';

const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
const ms = (v) => Date.parse(v ?? '') || 0;

/** 크루 → 부서별 묶음 [{ dept, crews }]. 부서 이름순(한국어), 부서가 없는 크루는 맨 뒤 한 묶음(dept '').
 *  부서 이름은 앞뒤 공백만 정리해 같은 부서로 본다 — 메신저에서 손으로 적는 칸이라 "영업 "과 "영업"이 갈리지 않게 */
export function groupByDept(crews) {
  const m = new Map();
  for (const c of crews) { const d = String(c.dept ?? '').trim(); if (!m.has(d)) m.set(d, []); m.get(d).push(c); }
  return [...m].map(([dept, list]) => ({ dept, crews: list.slice().sort(byName) }))
    .sort((a, b) => (!a.dept) - (!b.dept) || a.dept.localeCompare(b.dept, 'ko'));
}

/** 할 일을 만든 크루 id — 크루 도구(본체 src/gateway/office-work.mjs)가 source = { kind: 'crew', crew: 메신저 크루 id }로 남긴다. 사람이 만든 일은 null */
export const crewMadeBy = (task) => (task?.source?.kind === 'crew' && typeof task.source.crew === 'string' ? task.source.crew : null);

/** 크루가 맡은 일 — 이끄는 진행 중인 일(멈춘 일 먼저, 그 안은 최근 시작순)과 그 크루가 만든 열린 할 일(기한 가까운 순).
 *  할 일 담당자는 사람만 받으므로(서버 office_tasks 담당자 검사) 담당자가 아니라 '만든 크루'로 묶는다 */
export function crewWork(crewId, { work = [], tasks = [] }) {
  const runs = work.filter((w) => w.lead === crewId).sort((a, b) => (b.status === 'blocked') - (a.status === 'blocked') || ms(b.started) - ms(a.started));
  const open = tasks.filter((x) => crewMadeBy(x) === crewId && !x.done_at && !x.cancelled_at)
    .sort((a, b) => (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') || ms(b.created_at) - ms(a.created_at));
  return { runs, tasks: open };
}

/** 크루 상세에 모을 기록 — 결재 대기 전부, 최근 결정·산출물·일지는 limit건(최근순). 일지는 날짜·시각(한국 시각 글자)순 */
export function crewRecords(crewId, { approvals = [], decisions = [], outputs = [], journal = [] }, limit = 5) {
  const recent = (list, at) => list.filter((x) => x.crew === crewId).sort((a, b) => ms(at(b)) - ms(at(a)));
  const days = journal.flatMap((d) => d.entries.filter((e) => e.crew === crewId).map((e) => ({ ...e, day: d.date, space: d.space })));
  return {
    approvals: recent(approvals, (x) => x.at),
    decisions: recent(decisions, (x) => x.at).slice(0, limit),
    outputs: recent(outputs, (x) => x.at).slice(0, limit),
    journal: days.sort((a, b) => `${b.day} ${b.time}`.localeCompare(`${a.day} ${a.time}`)).slice(0, limit),
  };
}

/** 크루 상세의 맡기기 자리 — 'direct' 1:1 맡기기(내 크루, 예시 모드는 모두), 'off' 내 크루인데 지금 쓸 수 없음(꺼짐·권한),
 *  'channel' 남의 크루·회사 크루(메신저 채널에서 @이름으로). 좌측 목록·맡기기 창과 같은 규칙(1:1은 내 크루와만 열린다) */
export function crewAccess(crew, me, mode) {
  if (mode !== 'signedIn') return 'direct';
  if (!isMine(crew, me)) return 'channel';
  return usable(crew) ? 'direct' : 'off';
}

/** 맡긴 일의 최근 답(에이전트 상세 '최근 대화') — 메신저 1:1 글 → 한 줄씩. who: 'crew'(에이전트) | 'me'(사람), 본문은 한 줄로 240자까지, 새 글이 위 */
export function replyLines(rows) {
  return (rows ?? []).filter((m) => String(m.body ?? '').trim()).map((m) => {
    const text = String(m.body).replace(/\s+/g, ' ').trim();
    return { id: m.id, who: m.author_kind === 'crew' ? 'crew' : 'me', text: text.length > 240 ? `${text.slice(0, 240)}…` : text, at: m.created_at };
  });
}
