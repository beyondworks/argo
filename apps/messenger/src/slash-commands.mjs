// '/' 커맨더(유건 지시 2026-09-14) — 본체 크루 채팅·회의실의 커맨더와 같은 문법(슬래시 토큰 하나·접두 매칭)으로,
// 채널 크루들이 미러한 본체 명령(msgr_crews.commands: 별칭·스킬)을 후보로 낸다. 실행은 본체가 한다 —
// 여기서는 그 지시문을 입력창에 넣을 뿐이다(본체 runSlash와 같은 규칙: 바로 보내지 않고 사장이 덧붙여 보낸다).
import { SLASH_TOKEN_RE } from '../../../app/c/[ws]/slash-match.mjs';

/** 후보 계산. crews: [{ id, display_name, commands }]. 같은 명령이 여러 크루(같은 회사)에 있으면 하나로 묶고 크루를 나열한다.
    @returns null(토큰 아님 → 팝업 닫힘) | [{ key, kind, cmd, desc, insert, crews:[{id,name}] }] */
export function slashCandidates(text, crews, { skillPrefix = (title) => `${title} ` } = {}) {
  const tok = String(text ?? '').match(SLASH_TOKEN_RE);
  if (!tok) return null;
  const q = tok[1].toLowerCase();
  const hit = (s) => String(s ?? '').toLowerCase().startsWith(q);
  const byKey = new Map();
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

/** 선택 결과를 입력창 텍스트로 — 1:1 방은 방 자체가 대상이라 지시문만, 단체 방은 명령을 가진 크루가 하나면 @이름을 앞에 붙인다(둘 이상이면 사장이 @로 고른다). */
export function slashInsert(cand, { isDm }) {
  const one = !isDm && cand.crews.length === 1 ? cand.crews[0] : null;
  return { text: one ? `@${one.name} ${cand.insert}` : cand.insert, mention: one ? { kind: 'crew', id: one.id, name: one.name } : null };
}
