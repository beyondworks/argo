// HTTP 텍스트 러너 — 외부 에이전트(헤르메스·오픈클로·자체 엔드포인트)를 "회사 크루의 두뇌"로 붙이는 가장 얇은 어댑터
// (부록 N, 2026-09-08). 계약은 한 요청·한 응답:
//   POST <endpoint>  { prompt, model, cwd, kind, readOnly }   헤더 authorization: Bearer <ARGO_HTTP_KEY>(회사 자격이 있을 때)
//   ← 200 { text } | { reply } | { content } | text/plain 본문     비-2xx는 `API Error: <status> <본문 앞부분>`으로 던져
//     error-class·자가치유·턴 전 게이트(불변식 A: 401 → 다음 턴 차단)가 CLI 러너와 같은 자리에서 문다.
// 도구·권한 게이트는 없다(텍스트 러너 등급 — codex/gemini CLI와 같은 "게이트 밖" 표기). 엔드포인트는 크루 카드 frontmatter
// `endpoint:`(크루마다 다른 프로필·포트) — 카드에 없으면 정직하게 실패한다(조용한 폴백 금지).
export const HTTP_TEXT_MAX_BODY = 200_000; // 응답 상한(문자) — 폭주 엔드포인트가 스레드를 삼키지 않게

export async function execHttpText({ endpoint, prompt, model = '', cwd = '', kind = 'chat', readOnly = false, timeoutMs, signal = null, cred = null, fetchImpl = globalThis.fetch }) {
  const url = String(endpoint ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('http 러너: 크루 카드에 endpoint(http(s)://…)가 없습니다 — 카드 frontmatter에 `endpoint:`를 적어 주세요');
  const key = cred?.env?.ARGO_HTTP_KEY ? String(cred.env.ARGO_HTTP_KEY) : '';
  const signals = [AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30_000))]; if (signal) signals.push(signal);
  let r;
  try {
    r = await fetchImpl(url, {
      method: 'POST', signal: AbortSignal.any(signals),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ prompt, model: model || undefined, cwd, kind, readOnly }),
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    throw new Error(`API Error: 0 ${String(e?.cause?.code || e?.name || e?.message || e)} (${url})`); // 연결 실패 — 벤더 거절과 구분되는 status 0
  }
  const raw = (await r.text()).slice(0, HTTP_TEXT_MAX_BODY);
  if (!r.ok) throw new Error(`API Error: ${r.status} ${raw.slice(0, 300).replace(/\s+/g, ' ')}`);
  let text = raw;
  if (/^\s*[{[]/.test(raw)) { try { const j = JSON.parse(raw); text = String(j.text ?? j.reply ?? j.content ?? j.output ?? ''); } catch { /* JSON이 아니면 본문 그대로 */ } }
  return text.trim();
}
