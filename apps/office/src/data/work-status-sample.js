// 업무 현황 예시 데이터(서버 설정이 없는 예시 모드) — core/work-status.js가 처음 필요할 때 불러온다. 사람·회사는 가상이다.
// 서버 office_work_status와 같은 모양. 할 일은 할 일 화면과 같은 예시 행(calendar-sample.js)을 그대로 써서, 줄을 누르면 할 일 화면의 그 일이 열리고
// 할 일 패널에서 고친 보류 사유가 여기에도 보인다. 관리자가 아니면(예시 '린 스튜디오') 서버처럼 내 자리·내 일만.
import { ME, SPACES } from '../core/session.js';
import { SAMPLE_TASKS, SAMPLE_PEOPLE } from './calendar-sample.js';

const ago = (now, sec) => new Date(now - sec * 1000).toISOString();
const CREWS = [
  { id: 'crew-pepper', name: '페퍼', slug: 'pepper', hosting: 'local', seen: 12, department: '사업팀' },
  { id: 'crew-pepper-v', name: '페퍼 - v', slug: 'pepper-v', hosting: 'bot', seen: 300, department: null },
  { id: 'crew-mac', name: '맥가이버', slug: 'macgyver', hosting: 'local', seen: 3600 * 5, department: '개발팀' },
  { id: 'crew-mac-v', name: '맥가이버 - v', slug: 'macgyver-v', hosting: 'bot', seen: 40, department: null },
  { id: 'crew-luna', name: '루나', slug: 'luna', hosting: 'local', seen: 25, department: '사업팀' },
  { id: 'crew-otto', name: '오토', slug: 'otto', hosting: 'local', seen: 3600 * 2, department: '리서치팀' },
  { id: 'crew-hana', name: '하나', slug: 'hana', hosting: 'local', seen: 86400 * 3, department: '고객지원팀' },
  { id: 'crew-mio', name: '미오', slug: 'mio', hosting: 'local', seen: 86400 * 12, department: null },
];
const SESSIONS = [
  { id: 'sess-1', name: '맥가이버 - 정비사', project: 'argo', task_id: 't-s10', seen: 180 },
  { id: 'sess-2', name: '페퍼 - 총괄', project: 'lean-projects', task_id: null, seen: 2400 },
];

/** 예시 공간 키 → 서버 응답과 같은 모양(now 기준 시각) */
export function sampleWorkStatus(space, now = Date.now()) {
  const role = SPACES.find((s) => s.key === space)?.role, admin = role === 'owner' || role === 'admin';
  const mine = (owner) => admin || owner === ME.id;
  const crews = CREWS.map((c) => ({ id: c.id, name: c.name, slug: c.slug, hosting: c.hosting, owner: ME.id, last_seen_at: ago(now, c.seen), department: c.department })).filter((c) => mine(c.owner));
  const sessions = SESSIONS.map((s) => ({ id: s.id, name: s.name, project: s.project, owner: ME.id, task_id: s.task_id, last_seen_at: ago(now, s.seen) }));
  const tasks = SAMPLE_TASKS.filter((x) => x.org === space && !x.done_at && !x.cancelled_at && (admin || x.assignee === ME.id || x.created_by === ME.id))
    .map(({ org: _org, ...x }) => x); // 서버 응답에는 scope(조직)가 빠져 있다
  const ids = new Set(crews.map((c) => c.id));
  return {
    admin, now: new Date(now).toISOString(), crews, sessions,
    running: ids.has('crew-luna') ? [{ crew_id: 'crew-luna', started_at: ago(now, 20) }] : [],
    runs: ids.has('crew-pepper') ? [{ id: 'run-1', lead_crew_id: 'crew-pepper', goal: '10월 캠페인 경쟁사 가격 조사', status: 'running', created_at: ago(now, 900) }] : [],
    tasks, people: (SAMPLE_PEOPLE[space] ?? []).map((p) => ({ id: p.user_id, name: p.name })),
  };
}
