// 직원 명부 규칙(트랙 C, 유건 10/2 — 인트라넷 직원 화면을 조직 명부로). 순수 함수, 테스트로 잠근다.
// 인트라넷 직원 = 이름·역할·에이전트 + CLI 토큰. 오피스는 계정 멤버를 자동으로 싣고, 직무·부서·연락처·입사·퇴사를 더한다.
// CLI 토큰은 두지 않는다 — 직원마다 자기 계정으로 로그인해 에이전트를 연결한다(유건 10/2: 실행기는 같은 계정으로 쓴다).

export const AGENT_PRESETS = ['Claude Code', 'Codex', 'Hermes'];
// 인트라넷 에이전트 값 → 이름(이관)
export const AGENT_FROM_INTRANET = { claude: 'Claude Code', claude_code: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
export const agentLabel = (v) => AGENT_FROM_INTRANET[String(v ?? '').toLowerCase()] ?? (String(v ?? '').startsWith('hermes:') ? `Hermes · ${String(v).slice(7)}` : String(v ?? ''));

const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase();
/** 상태(active|left|all)·검색어(이름·직무·부서·연락처·에이전트) */
export function filterPeople(people, { status = 'active', q = '' } = {}) {
  const needle = norm(q).trim();
  return (people ?? []).filter((p) => (status === 'all' || p.status === status)
    && (!needle || [p.name, p.title, p.department, p.email, p.phone, p.agent].some((v) => norm(v).includes(needle))));
}

export const counts = (people) => ({ active: (people ?? []).filter((p) => p.status === 'active').length, left: (people ?? []).filter((p) => p.status === 'left').length, all: (people ?? []).length });

const D = /^\d{4}-\d{2}-\d{2}$/;
/** 폼 → 서버 person.save. 이름 없으면 null, 퇴사일이 입사일보다 이르면 null */
export function personPayload(form) {
  const name = String(form.name ?? '').trim();
  const joined = D.test(form.joined_on ?? '') ? form.joined_on : null, left = D.test(form.left_on ?? '') ? form.left_on : null;
  if (!name || (joined && left && left < joined)) return null;
  const s = (k, n) => String(form[k] ?? '').trim().slice(0, n);
  return { id: form.id, name: name.slice(0, 100), title: s('title', 100), department: s('department', 100), email: s('email', 200), phone: s('phone', 50),
    agent: s('agent', 100), joined_on: joined, left_on: left, notes: s('notes', 2000), user_id: form.user_id || null };
}

/** 계정 멤버 중 아직 명부 행과 연결 안 된 사람(연결 고르기) — 지금 연결된 계정은 남긴다 */
export const linkable = (people, current) => (people ?? []).filter((p) => p.user_id && (p.id === null || p.user_id === current));

/** 명부에서 고를 수 있는 줄(12차 제보 — 회색 4·체크 3·막대 4가 달랐다): 화면의 모든 줄(계정만 있는 직원 포함)이 같은 키로 체크박스·회색·개수가 하나다.
 *  ids = 지울 수 있는 명부 직원만(계정만 있는 직원은 계정이라 지우지 않는다) */
export const rowKeyOf = (p) => p.id ?? `u:${p.user_id}`;
export function selectable(list, sel) {
  const keys = list.map(rowKeyOf), ids = list.filter((p) => p.id).map((p) => p.id);
  return { keys, ids, picked: keys.filter((k) => sel.has(k)), deletable: ids.filter((id) => sel.has(id)), all: keys.length > 0 && keys.every((k) => sel.has(k)) };
}
