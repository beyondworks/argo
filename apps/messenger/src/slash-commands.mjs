// '/' 커맨더(유건 지시 2026-09-14) — 본체 크루 채팅·회의실의 커맨더와 같은 문법(슬래시 토큰 하나·접두 매칭)으로,
// 채널 크루들이 미러한 본체 명령(msgr_crews.commands: 별칭·스킬)을 후보로 낸다. 실행은 본체가 한다 —
// 여기서는 그 지시문을 입력창에 넣을 뿐이다(본체 runSlash와 같은 규칙: 바로 보내지 않고 사장이 덧붙여 보낸다).
import { SLASH_TOKEN_RE } from '../../../app/c/[ws]/slash-match.mjs';

/** 후보 계산. crews: [{ id, display_name, commands }]. 같은 명령이 여러 크루(같은 회사)에 있으면 하나로 묶고 크루를 나열한다.
    @returns null(토큰 아님 → 팝업 닫힘) | [{ key, kind, cmd, desc, insert, crews:[{id,name}] }] */
export function slashCandidates(text, crews, { skillPrefix = (title) => `${title} ` , builtins = [] } = {}) {
  const tok = String(text ?? '').match(SLASH_TOKEN_RE);
  if (!tok) return null;
  const q = tok[1].toLowerCase();
  const hit = (s) => String(s ?? '').toLowerCase().startsWith(q);
  const byKey = new Map();
  for (const b of builtins) if (b?.cmd) byKey.set(`b:${b.cmd}`, { kind: 'builtin', key: `b:${b.cmd}`, cmd: b.cmd, desc: b.desc ?? '', insert: `/${b.cmd} `, crews: [], match: [b.cmd] }); // 메신저 내장(/to·/cc) — 크루 명령보다 앞
  for (const c of Array.isArray(crews) ? crews : []) {
    for (const cmd of Array.isArray(c?.commands) ? c.commands : []) {
      const row = cmd?.kind === 'alias' && cmd.cmd && cmd.text ? { kind: 'alias', key: `a:${cmd.cmd}:${cmd.text}`, cmd: cmd.cmd, desc: cmd.text, insert: cmd.text, match: [cmd.cmd] }
        : cmd?.kind === 'skill' && cmd.id ? { kind: 'skill', key: `s:${cmd.id}`, cmd: cmd.id, desc: cmd.title || cmd.id, insert: skillPrefix(cmd.title || cmd.id), match: [cmd.id, cmd.title] }
        : null;
      if (!row) continue;
      const e = byKey.get(row.key) ?? { ...row, crews: [] };
      if (!e.crews.some((x) => x.id === c.id)) e.crews.push({ id: c.id, name: c.display_name ?? c.name ?? '' });
      byKey.set(row.key, e);
    }
  }
  return [...byKey.values()].filter((r) => r.match.some(hit)).map(({ match, ...r }) => r); // 별칭 먼저(삽입 순서), 그다음 스킬 — 본체와 같은 순서
}

/** 재조회 시간 제한 — supabase-js에는 기본 제한이 없어 응답이 안 오면 '불러오는 중'이 끝나지 않고 Enter도 계속 막힌다.
    8초: 같은 앱의 설정 조회(oauth-handoff PROVIDER_SETTINGS_TIMEOUT_MS)와 같고, 서버 statement_timeout(8초)과 맞춰 DB가 느려도 네트워크가 막혀도 같은 때 끝난다.
    가장 큰 경우(방 에이전트 30명 × 59KB ≈ 1.8MB)도 2Mbps에서 약 7초라 느린 회선의 정상 응답은 자르지 않는다. */
export const SLASH_READ_TIMEOUT_MS = 8_000;

/** '/' 팝업을 연 순간 그 방 에이전트의 최신 명령 목록만 따로 읽는다 — 조직 목록(loadOrg)은 commands 열(행당 최대 64KB)을 읽지 않는다(H33).
    @returns {Promise<{ok:true, cmds:{[crewId]: commands}} | {ok:false}>} 던지지 않는다. 오류 응답·402·네트워크 예외·시간 초과는 {ok:false}(실패),
    오류 없이 온 응답은 비어 있어도 {ok:true}(명령 없음) — 둘을 구분해야 실패 때 에이전트 명령이 안내 없이 사라지지 않는다.
    시간이 지나면 요청을 취소(AbortController — AbortSignal.timeout은 오래된 웹뷰에 없다)하고, 신호를 무시하는 전송이어도 끝나게 경쟁시킨다(oauth-handoff와 같은 방식). */
export async function readSlashCommands(db, ids, { timeoutMs = SLASH_READ_TIMEOUT_MS } = {}) {
  const ctl = new AbortController(); let timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error('timeout')); ctl.abort(); }, timeoutMs); });
  try {
    const query = db.from('msgr_crews').select('id, commands').in('id', ids);
    const { data, error } = await Promise.race([typeof query.abortSignal === 'function' ? query.abortSignal(ctl.signal) : query, timedOut]);
    if (error || !Array.isArray(data)) return { ok: false };
    return { ok: true, cmds: Object.fromEntries(data.map((r) => [r.id, r.commands])) };
  } catch { return { ok: false }; } finally { clearTimeout(timer); }
}

/** 팝업이 그릴 것 = { cands, loading, failed }. cands: slashCandidates 결과(토큰이 아니면 null). fresh = null(아직 안 옴) | readSlashCommands 결과. 재조회 값이 행 값보다 앞선다.
    unknown = 명령을 모르는 에이전트가 있다 — loadOrg 행에는 commands 열이 없다(undefined). 개인 공간 RPC 행은 내 것은 배열·남의 것은 null로 이미 정해져 있어 기다리지 않는다.
    loading = 재조회 전 → '명령 없음'이 아니라 '불러오는 중'. failed = 재조회가 실패했다 → '명령 없음'이 아니라 '불러오지 못했습니다'. */
export function slashView(text, crews, fresh, opts) {
  const list = Array.isArray(crews) ? crews : [];
  const cmds = fresh?.ok ? fresh.cmds : null;
  const cands = slashCandidates(text, list.map((c) => ({ ...c, commands: cmds?.[c.id] ?? c.commands })), opts);
  const unknown = list.some((c) => c?.commands === undefined);
  return { cands, loading: !!cands && !fresh && unknown, failed: !!cands && fresh?.ok === false && unknown };
}

/** 선택 결과를 입력창 텍스트로 — 1:1 방은 방 자체가 대상이라 지시문만, 단체 방은 명령을 가진 크루가 하나면 @이름을 앞에 붙인다(둘 이상이면 사장이 @로 고른다). */
export function slashInsert(cand, { isDm }) {
  const one = !isDm && cand.crews.length === 1 ? cand.crews[0] : null;
  return { text: one ? `@${one.name} ${cand.insert}` : cand.insert, mention: one ? { kind: 'crew', id: one.id, name: one.name } : null };
}

// 1:1 방의 수신·참조 고르기(유건 결정 2026-09-14 — "멘션이 사실상 to"): 서버는 역할 없는 @멘션을 to로 본다(coalesce(role,'to')).
// 그래서 별도 수신·참조 패널 대신 입력창 명령 하나로 — `/to 질의`는 @ 목록과 같은 목록(고르면 `@이름 ` 삽입), `/cc 질의`는 같은 목록(고르면 참조 칩).
export const ROLE_PICK_RE = /^\/(to|cc)(?:\s+(.*))?$/i; // 질의 = 나머지 전체(크루 이름엔 공백이 흔하다 — 검수 M-2). 명령이 글 전체를 차지할 때만 발동

/** @returns null(명령 아님) | { role:'to'|'cc', q, list:[{ kind:'crew', id, name, sub, disabled }] }
    exclude = 이미 본문에 있거나 참조로 고른 crew id. participants = 이 1:1 방의 상대 — /to에서만 뺀다(@상대는 중복), /cc에는 남긴다("답하지 말고 참고만") */
export function rolePickCandidates(text, candidates, { exclude = new Set(), participants = new Set() } = {}) {
  const m = String(text ?? '').match(ROLE_PICK_RE);
  if (!m) return null;
  const role = m[1].toLowerCase(); const q = (m[2] ?? '').trim().toLowerCase();
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) => c?.id && !exclude.has(c.id) && !(role === 'to' && participants.has(c.id)) && String(c.display_name ?? '').toLowerCase().includes(q))
    .map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text, disabled: c.delivery_ready !== true }));
  return { role, q, list };
}
