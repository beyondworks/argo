// 업무 현황(유건 10/8) — 서버 office_work_status가 준 크루·맥 세션·실행·작업·할 일을 '사람' 단위로 묶는 순수 계산. 화면은 pages/WorkStatus.jsx, 규칙은 test/work-status-model.test.mjs.
// 한 사람 = 주인(user id)이 같고 이름의 " - " 앞부분이 같은 자리들(맥 세션 "맥가이버 - 정비사" + VPS 봇 "맥가이버 - v" + 아르고 크루 "맥가이버"). 이름이 다르면 묶지 않는다("Pepper"와 "페퍼"는 다른 사람).
// 주인이 다르면 이름이 같아도 다른 사람이다(총괄 10/8 결정 다 — 남이 같은 이름의 에이전트·세션을 만들어 내 카드에 끼어들지 못하게).
// 할 일은 출처(source)를 손님이 적어 보낼 수 있으므로(서버는 source를 그대로 저장한다) 출처의 주인이 그 일의 만든 사람·맡은 사람과 맞을 때만 그 사람에게 붙인다.
import { kstDay } from './task-model.js';

export const CREW_ONLINE_MS = 90_000; // 크루 연결 — 오피스·메신저와 같은 90초(core/board.js AWAY_MS)
export const SESSION_ONLINE_MS = 15 * 60_000; // 맥 세션 연결 — 세션은 4분에 한 번만 보고하므로(값이 같으면) 15분
export const IDLE_MS = 7 * 86_400_000; // 업무도 연결도 없는 사람은 7일 안에 보였으면 '맡은 업무 없음' 한 줄, 더 오래되면 수만
export const PLACES = ['session', 'bot', 'local']; // 자리 — 맥 세션 · VPS(헤르메스 봇) · 아르고 크루

const ms = (iso) => { const v = Date.parse(iso ?? ''); return Number.isFinite(v) ? v : null; };
/** 사람 열쇠 — " - " 앞부분, 앞뒤 공백 제거, 라틴 소문자(한글은 그대로). 앞부분이 비면 이름 전체 */
export function personKey(name) {
  const s = String(name ?? '').normalize('NFC').trim(), i = s.indexOf(' - ');
  return (i > 0 ? s.slice(0, i).trim() : s).toLowerCase();
}
/** 사람 카드 열쇠 — (주인 user id, 이름 앞부분) */
export const cardKey = (owner, name) => `${owner ?? ''}|${personKey(name)}`;
/** 보이는 이름 — 열쇠와 같은 자르기(대소문자는 그대로) */
const personName = (name) => { const s = String(name ?? '').normalize('NFC').trim(), i = s.indexOf(' - '); return i > 0 ? s.slice(0, i).trim() : s; };
/** 메모 첫 줄(빈 줄은 건너뛴다) */
/** 할 일의 출처 표시 — 이름은 주인 대조를 통과해 사람 카드에 붙은 일(person 있음)만 보인다.
 *  대조에 실패한 출처(남의 크루 id·이름을 적어 보낸 일)는 이름 없이 '에이전트'·'세션'으로만 — source 칸은 서버가 검사하지 않는 바깥 글이다(재검증 10/8). */
export function sourceOf(row) {
  const kind = row?.source?.kind === 'session' ? 'session' : row?.source?.kind === 'crew' ? 'crew' : 'person';
  if (kind === 'person' || !row.person) return { kind, name: null };
  return { kind, name: (kind === 'session' ? row.source.name : row.personName) || row.personName || null };
}
export const firstLine = (note) => String(note ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
/** 열린 할 일의 칸 — 진행 중(doing)·보류(hold)·시작 전(그 밖) */
const bucketOf = (task) => (task.status === 'doing' ? 'doing' : task.status === 'hold' ? 'held' : 'todo');
// 같은 칸 안 순서 — 기한 빠른 것(없으면 뒤) → 중요도 높은 것 → 먼저 만든 것
const byDue = (a, b) => (a.due_on && b.due_on ? a.due_on.localeCompare(b.due_on) : (!a.due_on) - (!b.due_on))
  || (Number(a.priority ?? 2) - Number(b.priority ?? 2)) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * data: office_work_status 응답 { admin, now, crews, sessions, running, runs, tasks, people }, me: 내 user id, now: 기준 시각(ms, 없으면 data.now → 지금).
 * → { summary: { doing, hold, overdue, online, people }, held: [할 일], people: [사람], idle: [사람], hidden: n, unowned: { doing, held, todo } }
 * 사람: { key(cardKey), name, owner, ownerName(people에 없으면 null), places: { session, bot, local }, online, lastSeen(ms|null), mine, now: [{ kind: 'run'|'exec'|'session', text, id?(run·할 일), place?(exec — 어느 자리가 답하는 중) }], doing, held, todo, overdue(n), nextDue }
 * 사람은 크루·세션(자리)으로만 생긴다. 할 일 행에는 person(열쇠|null)·personName·assigneeName·overdue·noteLine을 붙인다.
 * 할 일 → 사람: source.kind 'crew'는 목록에 있는 그 크루의 주인이 그 일의 만든 사람 또는 맡은 사람일 때만 그 크루의 사람, 'session'은 만든 사람의
 * 같은 이름 앞부분 자리 묶음이 있을 때만. 그 밖(사람이 만든 일, 맞지 않는 출처, 목록에 없는 크루, 이름 없는 세션)은 '에이전트 없이 맡긴 일'(unowned).
 * 세션의 task_id → '지금 하는 일'은 세션 주인이 그 일의 맡은 사람 또는 만든 사람일 때만.
 */
export function buildStatus(data, { me = null, now } = {}) {
  const at = now ?? ms(data?.now) ?? Date.now();
  const today = kstDay(new Date(at));
  const crews = data?.crews ?? [], sessions = data?.sessions ?? [], tasks = data?.tasks ?? [];
  const names = new Map((data?.people ?? []).map((p) => [p.id, p.name ?? null]));
  const crewById = new Map(crews.map((c) => [c.id, c]));
  const map = new Map();
  const person = (owner, rawName, rank) => {
    if (!personKey(rawName)) return null;
    const key = cardKey(owner, rawName);
    let p = map.get(key);
    if (!p) {
      p = { key, name: personName(rawName), owner: owner ?? null, ownerName: owner ? names.get(owner) ?? null : null, rank, places: { session: [], bot: [], local: [] },
        online: false, lastSeen: null, mine: !!me && owner === me, now: [], doing: [], held: [], todo: [], overdue: 0, nextDue: null };
      map.set(key, p);
    } else if (rank < p.rank) { p.name = personName(rawName); p.rank = rank; } // 보이는 이름은 아르고 크루 → VPS → 세션 순으로 정한다
    return p;
  };
  const seen = (p, iso, limit) => {
    const s = ms(iso);
    if (s == null) return;
    if (p.lastSeen == null || s > p.lastSeen) p.lastSeen = s;
    if (at - s < limit) p.online = true;
  };
  for (const c of crews) {
    const place = c.hosting === 'bot' ? 'bot' : 'local'; // 'local'·'resident' = 아르고 크루, 'bot' = VPS 헤르메스 봇
    const p = person(c.owner, c.name, place === 'local' ? 0 : 1);
    if (!p) continue;
    p.places[place].push(c); seen(p, c.last_seen_at, CREW_ONLINE_MS);
  }
  const sessionOf = new Map();
  for (const s of sessions) {
    const p = person(s.owner, s.name, 2);
    if (!p) continue;
    p.places.session.push(s); seen(p, s.last_seen_at, SESSION_ONLINE_MS); sessionOf.set(s.id, p);
  }
  const crewPerson = (id) => { const c = crewById.get(id); return c ? map.get(cardKey(c.owner, c.name)) : undefined; };
  /** 할 일의 사람 — 출처의 주인이 그 일의 만든 사람·맡은 사람과 맞을 때만(위 설명) */
  const taskPerson = (raw, src) => {
    if (src?.kind === 'crew') {
      const c = crewById.get(src.crew);
      return c && c.owner && (c.owner === raw.created_by || c.owner === raw.assignee) ? crewPerson(c.id) ?? null : null;
    }
    if (src?.kind === 'session' && raw.created_by && personKey(src.name)) return map.get(cardKey(raw.created_by, src.name)) ?? null;
    return null;
  };

  // 할 일 → 사람(taskPerson). 맞는 사람이 없으면 '에이전트 없이 맡긴 일'
  const unowned = { doing: [], held: [], todo: [] }, held = [], open = new Map();
  const summary = { doing: 0, hold: 0, overdue: 0, online: 0, people: 0 };
  for (const raw of tasks) {
    if (raw.done_at || raw.cancelled_at) continue;
    const src = raw.source && typeof raw.source === 'object' ? raw.source : null;
    const p = taskPerson(raw, src);
    const overdue = !!raw.due_on && raw.due_on < today;
    const row = { ...raw, person: p?.key ?? null, personName: p?.name ?? null, assigneeName: raw.assignee ? names.get(raw.assignee) ?? null : null, overdue, noteLine: firstLine(raw.note) };
    const b = bucketOf(raw);
    (p ? p[b] : unowned[b]).push(row);
    open.set(raw.id, row);
    if (b === 'doing') summary.doing++;
    if (b === 'held') { summary.hold++; held.push(row); }
    if (overdue) { summary.overdue++; if (p) p.overdue++; }
    if (p && raw.due_on && raw.due_on >= today && (!p.nextDue || raw.due_on < p.nextDue)) p.nextDue = raw.due_on;
  }
  for (const list of [unowned.doing, unowned.held, unowned.todo]) list.sort(byDue);

  // 지금 하는 일 — 작업(run) → 세션이 맡은 할 일 → 답하는 중인 실행(작업이 없는 크루만)
  const runCrews = new Set();
  for (const r of data?.runs ?? []) {
    const p = crewPerson(r.lead_crew_id);
    if (!p) continue;
    p.now.push({ kind: 'run', text: r.goal ?? '', id: r.id, status: r.status });
    if (r.status === 'running') runCrews.add(r.lead_crew_id);
  }
  for (const s of sessions) {
    const p = sessionOf.get(s.id), task = s.task_id ? open.get(s.task_id) : null;
    if (p && task && s.owner && (task.assignee === s.owner || task.created_by === s.owner) && !p.now.some((x) => x.kind === 'session' && x.id === task.id)) p.now.push({ kind: 'session', text: task.title, id: task.id });
  }
  for (const e of data?.running ?? []) {
    const p = crewPerson(e.crew_id);
    if (p && !runCrews.has(e.crew_id) && !p.now.some((x) => x.kind === 'exec' && x.crewId === e.crew_id)) { const c = crewById.get(e.crew_id); p.now.push({ kind: 'exec', text: c.name, place: c.hosting === 'bot' ? 'bot' : 'local', crewId: e.crew_id, at: e.started_at }); }
  }

  // 정렬 — 연결된 사람 → 업무가 있는 사람 → 나머지(같으면 이름순). 업무도 연결도 없으면 7일 안에 보였을 때만 한 줄, 그보다 오래되면 수만
  const busy = (p) => p.doing.length + p.held.length + p.todo.length > 0;
  const rank = (p) => (p.online ? 0 : busy(p) ? 1 : 2);
  const all = [...map.values()].map((p) => { p.doing.sort(byDue); p.held.sort(byDue); p.todo.sort(byDue); delete p.rank; return p; })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko') || (b.mine - a.mine) || String(a.owner).localeCompare(String(b.owner)));
  const people = [], idle = [];
  let hidden = 0;
  for (const p of all) {
    summary.people++; // 사람은 자리(크루·세션)로만 생긴다
    if (p.online) summary.online++;
    if (p.online || busy(p)) people.push(p);
    else if (p.lastSeen != null && at - p.lastSeen <= IDLE_MS) idle.push(p);
    else hidden++;
  }
  // 보류된 업무 — 오래 묶인 일부터(보류한 때가 없으면 맨 뒤)
  held.sort((a, b) => (ms(a.held_at) ?? Infinity) - (ms(b.held_at) ?? Infinity) || byDue(a, b));
  return { summary, held, people, idle, hidden, unowned };
}
