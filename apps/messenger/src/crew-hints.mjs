// 같은 이름의 에이전트를 목록에서 구별하는 보조 정보 — 순수 함수(App.jsx 레일·새 채팅 시트가 쓴다). 점검 A·B #12.
// 이름이 겹친 에이전트에만 이미 데이터에 있는 정보를 붙인다: 종류(아르고·헤르메스·오픈클로·외부, 이름에 이미 들어 있으면 생략) · 만든 날, 같은 날이면 시각, 끝내 같으면 만든 순서 번호.
// 겹치지 않는 이름에는 아무것도 붙이지 않는다(목록이 지저분해지지 않게).

const norm = (n) => String(n ?? '').trim().toLowerCase();
const pad = (n) => String(n).padStart(2, '0');
const dateOf = (iso, lang) => { const d = new Date(iso); return lang === 'en' ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : `${d.getMonth() + 1}월 ${d.getDate()}일`; };
const timeOf = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const valid = (iso) => !!iso && !Number.isNaN(Date.parse(iso));

/** crews → Map<crewId, 보조 문구> (이름이 겹친 에이전트만). sourceLabel(crew) = 종류 이름. */
export function duplicateNameHints(crews, { lang = 'ko', sourceLabel }) {
  const groups = new Map();
  for (const c of crews) { const k = norm(c.display_name); if (k) (groups.get(k) ?? groups.set(k, []).get(k)).push(c); }
  const out = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const kindText = (c) => { const k = sourceLabel(c); return norm(c.display_name).includes(norm(k)) ? '' : k; }; // 이름에 이미 종류가 있으면("유건의 오픈클로") 같은 말을 되풀이하지 않는다
    const build = (c, withTime) => [kindText(c), valid(c.created_at) ? `${dateOf(c.created_at, lang)}${withTime ? ` ${timeOf(c.created_at)}` : ''}` : ''].filter(Boolean).join(' · ');
    let texts = group.map((c) => build(c, false));
    if (new Set(texts).size < texts.length) texts = group.map((c) => build(c, true)); // 같은 날 — 시각까지
    if (new Set(texts).size < texts.length) { // 분까지 같다 — 만든 순서 번호(같은 문구끼리만)
      const order = [...group].sort((x, y) => Date.parse(x.created_at ?? 0) - Date.parse(y.created_at ?? 0) || String(x.id).localeCompare(String(y.id)));
      const ord = new Map(order.map((c, i) => [c.id, i + 1]));
      texts = group.map((c, i) => { const same = texts.filter((x) => x === texts[i]).length > 1; return same ? `${texts[i]} #${ord.get(c.id)}` : texts[i]; });
    }
    group.forEach((c, i) => out.set(c.id, texts[i]));
  }
  return out;
}
