// HTTP 텍스트 러너 — 외부 에이전트(헤르메스·오픈클로·자체 엔드포인트)를 "회사 크루의 두뇌"로 붙이는 가장 얇은 어댑터
// (부록 N, 2026-09-08). 계약은 한 요청·한 응답:
//   POST <endpoint>  { prompt, model, cwd, kind, readOnly }   헤더 authorization: Bearer <ARGO_HTTP_KEY>(회사 자격이 있을 때)
//   ← 200 { text } | { reply } | { content } | text/plain 본문     비-2xx는 `API Error: <status> <본문 앞부분>`으로 던져
//     error-class·자가치유·턴 전 게이트(불변식 A: 401 → 다음 턴 차단)가 CLI 러너와 같은 자리에서 문다.
// 도구·권한 게이트는 없다(텍스트 러너 등급 — codex/gemini CLI와 같은 "게이트 밖" 표기). 엔드포인트는 크루 카드 frontmatter
// `endpoint:`(크루마다 다른 프로필·포트) — 카드에 없으면 정직하게 실패한다(조용한 폴백 금지).
export const HTTP_TEXT_MAX_BODY = 200_000; // 응답 상한(문자) — 폭주 엔드포인트가 스레드를 삼키지 않게

/** 요청·응답 형식(카드 frontmatter `format:`). 'argo'(기본) = 위 계약. 'openai-chat' = OpenAI 호환 /v1/chat/completions(헤르메스 API 서버가 이 모양 —
    ~/.hermes/hermes-agent/gateway/platforms/api_server.py 실물 확인 2026-09-08 — 이므로 헤르메스 쪽 변경 0으로 붙는다). */
export const HTTP_TEXT_FORMATS = ['argo', 'openai-chat'];
export function buildHttpTextRequest({ format = 'argo', prompt, model = '', cwd = '', kind = 'chat', readOnly = false }) {
  if (format === 'openai-chat') return { model: model || 'default', messages: [{ role: 'user', content: prompt }], stream: false };
  return { prompt, model: model || undefined, cwd, kind, readOnly };
}
export function parseHttpTextResponse(format, raw) {
  if (!/^\s*[{[]/.test(raw)) return raw;
  let j; try { j = JSON.parse(raw); } catch { return raw; }
  if (format === 'openai-chat') { const c = j?.choices?.[0]?.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : String(j.text ?? j.output_text ?? ''); }
  return String(j.text ?? j.reply ?? j.content ?? j.output ?? '');
}

export async function execHttpText({ endpoint, format = 'argo', prompt, model = '', cwd = '', kind = 'chat', readOnly = false, timeoutMs, signal = null, cred = null, fetchImpl = globalThis.fetch }) {
  if (!HTTP_TEXT_FORMATS.includes(format)) throw new Error(`http 러너: 모르는 format "${format}" — ${HTTP_TEXT_FORMATS.join('|')} 중 하나`);
  const url = String(endpoint ?? '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('http 러너: 크루 카드에 endpoint(http(s)://…)가 없습니다 — 카드 frontmatter에 `endpoint:`를 적어 주세요');
  const key = cred?.env?.ARGO_HTTP_KEY ? String(cred.env.ARGO_HTTP_KEY) : '';
  const signals = [AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 30_000))]; if (signal) signals.push(signal);
  let r;
  try {
    r = await fetchImpl(url, {
      method: 'POST', signal: AbortSignal.any(signals),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(buildHttpTextRequest({ format, prompt, model, cwd, kind, readOnly })),
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
    throw new Error(`API Error: 0 ${String(e?.cause?.code || e?.name || e?.message || e)} (${url})`); // 연결 실패 — 벤더 거절과 구분되는 status 0
  }
  const raw = (await r.text()).slice(0, HTTP_TEXT_MAX_BODY);
  if (!r.ok) throw new Error(`API Error: ${r.status} ${raw.slice(0, 300).replace(/\s+/g, ' ')}`);
  return parseHttpTextResponse(format, raw).trim();
}
