// '/' 커맨더 후보 계산 — 크루 채팅(crew/[slug])과 회의실(room)이 같은 문법을 공유하는 순수 함수.
// 입력이 **슬래시 토큰 하나**(`/`, `/보고`)일 때만 발동하고, 문장 속 '/'나 공백 뒤는 일반 텍스트다.
// 후보 순서 = 내장 명령 → 회사 별칭(company.json.aliases) → 회사 스킬(market installedSkills).
// 매칭은 대소문자 무시 접두(prefix) — 빈 질의(`/`)는 전부 나열한다.
export const SLASH_TOKEN_RE = /^\/(\S*)$/;

/**
 * @returns {null|Array} 토큰이 아니면 null(패널 닫힘), 토큰이면 후보 배열(0개 가능).
 * builtins: [{ id, aliases: ['new', '새대화'], label, run }] — cmd 표시는 첫 별칭.
 * aliases:  [{ cmd, text }] — 저장된 지시를 삽입.
 * skills:   [{ id, title }] — skillInsert(s)가 만든 사용 지시를 삽입.
 */
export function matchSlash(input, { builtins = [], aliases = [], skills = [], skillInsert = (s) => s.title } = {}) {
  const tok = String(input ?? '').match(SLASH_TOKEN_RE);
  if (!tok) return null;
  const q = tok[1].toLowerCase();
  const hit = (s) => String(s ?? '').toLowerCase().startsWith(q);
  return [
    ...builtins.filter((c) => c.aliases.some(hit))
      .map((c) => ({ kind: 'builtin', key: `b:${c.id}`, cmd: c.aliases[0], desc: c.label, run: c.run })),
    ...aliases.filter((a) => hit(a.cmd))
      .map((a) => ({ kind: 'alias', key: `a:${a.cmd}`, cmd: a.cmd, desc: a.text, insert: a.text })),
    ...skills.filter((s) => hit(s.id) || hit(s.title))
      .map((s) => ({ kind: 'skill', key: `s:${s.id}`, cmd: s.id, desc: s.title, insert: skillInsert(s) })),
  ];
}
