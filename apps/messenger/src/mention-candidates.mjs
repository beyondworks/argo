// @멘션 후보 — 사람을 먼저, 크루를 뒤에(유건 제보 2026-09-11: 크루가 8명을 넘으면 상한에 잘려 채널에 들어온 사람이 아예 안 떴다).
// 나 자신은 뺀다(슬랙과 같다). 검색어가 있으면 이름 부분 일치. 상한 없음 — 후보가 이 채널의 참여 구성뿐이라 구성원은 전원 보여야 한다
// (유건 제보 2026-09-11 밤: 상한 8에 잘려 비공개 채널의 Walter·Wolff·Yoda가 '@'만 쳐서는 안 떴다). 팝업은 max-height + 스크롤.
export function mentionCandidates({ q = '', crews = [], members = [], uid = null, max = Infinity } = {}) {
  const needle = q.toLowerCase();
  const people = members.filter((m) => m.user_id !== uid).map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }));
  const agents = crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text }));
  return [...people, ...agents].filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, max);
}

// 본문의 @이름 → 멘션 배열. 긴 이름부터 맞추고 맞춘 구간은 지워, "@페퍼 (VPS)" 안의 "@페퍼"가 다른 크루로 새지 않게 한다
// (실사고 2026-09-11: 사설 채널 밖 페퍼가 답함). picked = 팝업에서 고른 것(같은 규칙으로 본문에 아직 있는지 확인).
// candidates = 이 채널에서 부를 수 있는 사람·크루만.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionRe = (name, flags = '') => new RegExp(`(^|\\s)@${esc(name)}(?=$|[\\s,.!?:;])`, `i${flags}`); // 대소문자 무시(@edna = Edna)
export function mentionsFromBody(body, candidates, picked = []) {
  let text = body; const out = []; const seen = new Set();
  const all = [...picked, ...candidates].filter((x) => x?.name).sort((a, b) => b.name.length - a.name.length);
  for (const x of all) {
    const key = `${x.kind}:${x.id}`; if (seen.has(key)) continue;
    if (!mentionRe(x.name).test(text)) continue;
    seen.add(key); out.push({ kind: x.kind, id: x.id });
    text = text.replace(mentionRe(x.name, 'g'), (m, lead) => lead + ' '.repeat(m.length - lead.length)); // 구간 소진 — 길이 유지
  }
  return out;
}
