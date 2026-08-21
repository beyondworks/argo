// 인트라넷(AI-Native) 같은 외부 앱이 보낸 사용자 메시지의 "봉투" 분해 — 순수 함수.
// 포맷(chat-thread.tsx 실측): 본문 + "\n\n---\n[현재 페이지 컨텍스트] 제목 · 경로\n<innerText 4000자>".
// 일부 호출부는 "[최근 대화]\n…\n\n[지시]\n…"처럼 줄머리 대괄호 헤더로 구획을 나눈다.
// 사장이 친 말은 [지시](없으면 첫 헤더 앞 텍스트)이고, 나머지 구획은 접힌 첨부로 보여야
// "에이전트가 왜 이런 글을 올리지"(유건 2026-08-21)가 생기지 않는다. 원문은 그대로 보존한다.
const KNOWN = ['최근 대화', '지시', '현재 페이지 컨텍스트'];
const HEAD = /^(?:---\n)?\[([^\]\n]{1,40})\]([^\n]*)\n?/gm;

/** @returns {{main:string, parts:{label:string, text:string}[]}|null} 봉투가 아니면 null */
export function splitEnvelope(text) {
  if (typeof text !== 'string' || !KNOWN.some((k) => text.includes(`[${k}]`))) return null;
  const heads = [...text.matchAll(HEAD)];
  if (heads.length === 0) return null;
  const sections = [];
  const lead = text.slice(0, heads[0].index).replace(/\n?---\s*$/, '').trim();
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    const title = h[2].trim();
    const body = text.slice(start, end).replace(/\n?---\s*$/, '').trim();
    sections.push({ label: h[1].trim(), text: title ? (body ? `${title}\n${body}` : title) : body });
  });
  const mi = sections.findIndex((s) => s.label === '지시');
  const main = mi >= 0 ? sections.splice(mi, 1)[0].text : lead;
  if (mi >= 0 && lead) sections.unshift({ label: '', text: lead }); // 지시 앞 자유 텍스트도 버리지 않는다
  return { main, parts: sections.filter((s) => s.text) };
}
