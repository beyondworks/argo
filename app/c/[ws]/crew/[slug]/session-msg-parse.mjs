// 1:1 채팅 입력창의 세션 메시지 문법 — 입력이 `@이름 내용`으로 시작하고 이름이 이 회사의 다른 크루면 세션 메시지다(src/session-msg.mjs).
// 모르는 이름·자기 자신·내용 없음은 null → 평소처럼 이 크루에게 보낸다(예전에 쓰던 '@' 문장이 갑자기 다른 데로 가지 않게).
const norm = (s) => String(s ?? '').normalize('NFC').toLowerCase().trim();

/** 자동 완성에 넣을 이름 — 공백이 있는 이름은 한 토큰이 아니라서 slug를 넣는다. */
export const mentionToken = (a) => (/\s/.test(a.name ?? '') ? a.slug : a.name);

/** 입력 끝의 `@부분`에 맞는 후보(자기 자신·외부 에이전트 제외). 입력 맨 앞의 토큰일 때만 연다 — 세션 메시지는 `@이름`으로 시작하는 글이다. */
export function sessionCandidates(input, crew, selfSlug, max = 12) {
  const m = /^@(\S*)$/.exec(String(input ?? ''));
  if (!m) return null;
  const q = norm(m[1]);
  return (crew ?? [])
    .filter((a) => a.slug !== selfSlug && norm(a.runner) !== 'http')
    .filter((a) => !q || norm(a.name).startsWith(q) || norm(a.slug).startsWith(q))
    .slice(0, max);
}

/** `@이름 내용` → { to, toName, message } 또는 null. */
export function parseSessionTarget(text, crew, selfSlug) {
  const m = /^@(\S+)\s+([\s\S]*\S[\s\S]*)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const key = norm(m[1]);
  const a = (crew ?? []).find((x) => norm(x.slug) === key || norm(x.name) === key);
  if (!a || a.slug === selfSlug || norm(a.runner) === 'http') return null;
  return { to: a.slug, toName: a.name, message: m[2].trim() };
}

/** 카드에 보일 본문 — 서버(src/session-msg.mjs)가 만든 글에서 모델용 머리말을 뗀다.
    받은 줄(in): 머리말 단락 뒤가 보낸 내용. 깨움 알림(사용자 줄 reply): 마지막 단락 묶음의 첫 줄("X의 답:") 뒤가 답. 그 밖은 원문. */
export function sessionBody(m) {
  const text = String(m?.text ?? '');
  const s = m?.src;
  if (s?.kind !== 'session' || m.who !== 'user') return text;
  const parts = text.split('\n\n');
  if (s.dir === 'in') return parts.length > 1 ? parts.slice(1).join('\n\n') : text;
  if (s.dir === 'reply' && parts.length > 2) { const rest = parts.slice(2).join('\n\n'); const nl = rest.indexOf('\n'); return nl >= 0 ? rest.slice(nl + 1) : rest; }
  return text;
}
