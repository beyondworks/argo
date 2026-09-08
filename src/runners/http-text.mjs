// HTTP 텍스트 러너 — 외부 에이전트(헤르메스·오픈클로·자체 엔드포인트)를 "회사 크루의 두뇌"로 붙이는 가장 얇은 어댑터
// (부록 N, 2026-09-08). 계약은 한 요청·한 응답:
//   format 'argo'(기본):   POST <endpoint> { prompt, model, kind, readOnly } → 200 { text|reply|content|output } 또는 text/plain
//   format 'openai-chat':  POST <endpoint> { model, messages:[{role:'user',content}], stream:false } → choices[0].message.content
//                          (헤르메스 게이트웨이 API 서버 /v1/chat/completions가 이 모양 — ~/.hermes/hermes-agent/gateway/platforms/api_server.py 실물 2026-09-08)
//   헤더 authorization: Bearer <회사 http 자격>. 자격 값이 'none'이면 무인증 엔드포인트(로컬 헤르메스·오픈클로) — 헤더 없음(분리 검수 MEDIUM-2).
// 오류: 비-2xx는 `API Error: <status> …`(+ httpStatus)로 던져 error-class·자가치유가 CLI 러너와 같은 자리에서 문다. 401·403은 chat.mjs의
// surfaceRunnerFailure가 **벤더 확정**으로 각인해 다음 턴을 실행 전에 끊는다(불변식 A — 이 러너는 엔드포인트가 카드에 있어 독립 프로브가
// 없다, 분리 검수 HIGH-1). 시간 초과는 timedOut 오류(CLI 러너와 같은 안내), 연결 실패는 status 0.
// 목적지 가드(분리 검수 HIGH-3): userinfo 금지 · 루프백·사설 대역·localhost는 http 허용 · 그 밖의 호스트는 https만 · 리다이렉트 거절 ·
// 호스팅 런타임(ARGO_TENANT_OWNER)은 서버발 SSRF 표면이라 러너 자체를 막는다. 도구·권한 게이트는 없다(텍스트 러너 등급 — 시트 정직 표기는 N-3).
export const HTTP_TEXT_MAX_BODY = 200_000; // 응답 상한(바이트) — 스트림으로 세며 넘기면 끊는다(전량 버퍼링 금지, 분리 검수 MEDIUM-1)
export const HTTP_TEXT_FORMATS = ['argo', 'openai-chat'];
export const HTTP_TEXT_NO_AUTH = 'none'; // 회사 자격 값이 이것이면 Bearer를 만들지 않는다

const ko_en = (ko, en) => `${ko} ${en}`;
const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./]; // 169.254/16(클라우드 메타데이터)·0.0.0.0은 사설이 아니라 차단(2차 검수 HIGH-C)
const BLOCKED_V4 = [/^169\.254\./, /^0\.0\.0\.0$/, /^0\./];
const isPrivateHost = (h) => {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((re) => re.test(host));
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true; // IPv6 loopback·ULA·link-local
  return false;
};

/** 엔드포인트 가드(순수) — 통과하면 정규화된 URL 문자열, 아니면 던진다. */
const isBlockedHost = (h) => { const host = h.replace(/^\[|\]$/g, '').toLowerCase(); return BLOCKED_V4.some((re) => re.test(host)); };
/** 호스팅 런타임 판정 — market.mjs arbitraryMcpBlocked와 **같은 술어**(임의 목적지로 나가는 능력 = 서비스 키 곁 유출 표면, 2차 검수 HIGH-C). 동적 import로 순환 회피. */
export async function httpRunnerBlockedHere() { const { arbitraryMcpBlocked } = await import('../market.mjs'); return arbitraryMcpBlocked(); }
export async function assertHttpTextEndpoint(endpoint, { hosted } = {}) {
  const raw = String(endpoint ?? '').trim().replace(/^["']|["']$/g, ''); // 손편집 YAML 따옴표 허용(persona looseField 관례, 3차 검수 L-3)
  const blocked = hosted === undefined ? await httpRunnerBlockedHere() : !!hosted; // 기본값도 정본 술어(3차 검수 M-A) — 직접 호출자(N-3 저장 검증)가 약한 판정을 타지 않게
  if (!raw) throw new Error(ko_en('http 러너: 크루 카드에 endpoint(http(s)://…)가 없습니다 — 카드 frontmatter에 `endpoint:`를 적어 주세요.', 'http runner: the crew card has no `endpoint:` (http(s)://…) in its frontmatter.'));
  let u; try { u = new URL(raw); } catch { throw new Error(ko_en(`http 러너: endpoint가 URL이 아닙니다 (${raw.slice(0, 80)}).`, 'http runner: endpoint is not a URL.')); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(ko_en('http 러너: endpoint는 http:// 또는 https://여야 합니다.', 'http runner: endpoint must be http:// or https://.'));
  if (u.username || u.password) throw new Error(ko_en('http 러너: endpoint에 사용자명·비밀번호를 넣을 수 없습니다 — 키는 설정의 러너 자격으로.', 'http runner: userinfo in endpoint is not allowed — put the key in the runner credential.'));
  if (blocked) throw new Error(ko_en('http 러너는 호스팅 런타임에서 쓸 수 없습니다(서버발 요청 표면) — 로컬 아르고·회사 노드에서만.', 'http runner is unavailable in the hosted runtime (server-side request surface) — use local Argo or a company node.'));
  if (isBlockedHost(u.hostname)) throw new Error(ko_en(`http 러너: ${u.hostname}은(는) 허용되지 않는 목적지입니다(링크로컬·메타데이터·0.0.0.0).`, `http runner: ${u.hostname} is not an allowed destination (link-local/metadata/0.0.0.0).`));
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) throw new Error(ko_en(`http 러너: 공인 호스트(${u.hostname})는 https만 허용합니다.`, `http runner: public host ${u.hostname} requires https.`));
  return u.toString();
}

export function buildHttpTextRequest({ format = 'argo', prompt, model = '', kind = 'chat', readOnly = false }) {
  if (format === 'openai-chat') return { model: model || 'default', messages: [{ role: 'user', content: prompt }], stream: false };
  return { prompt, model: model || undefined, kind, readOnly }; // cwd 등 로컬 경로는 보내지 않는다(최소 정보, 분리 검수 LOW-8)
}
const joinContent = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).join('') : c == null ? '' : String(c);
export function parseHttpTextResponse(format, raw) {
  if (!/^\s*[{[]/.test(raw)) return raw;
  let j; try { j = JSON.parse(raw); } catch { return raw; }
  if (Array.isArray(j)) return joinContent(j);
  if (format === 'openai-chat') { const c = j?.choices?.[0]?.message?.content; return c != null ? joinContent(c) : joinContent(j.text ?? j.output_text ?? ''); }
  return joinContent(j.text ?? j.reply ?? j.content ?? j.output ?? '');
}

/** 본문을 바이트로 세며 읽는다 — 상한을 넘기면 연결을 끊고 던진다. */
async function readCapped(r, cap) {
  if (Number(r.headers.get('content-length')) > cap) { try { await r.body?.cancel(); } catch { /* 이미 닫힘 */ } throw new Error(ko_en(`http 러너: 응답이 상한(${cap}B)을 넘습니다.`, `http runner: response exceeds the ${cap}B cap.`)); }
  if (!r.body) return '';
  const reader = r.body.getReader(); const chunks = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.byteLength; if (n > cap) { try { await reader.cancel(); } catch { /* 무해 */ } throw new Error(ko_en(`http 러너: 응답이 상한(${cap}B)을 넘습니다.`, `http runner: response exceeds the ${cap}B cap.`)); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export async function execHttpText({ endpoint, format = 'argo', prompt, model = '', kind = 'chat', readOnly = false, timeoutMs, signal = null, cred = null, fetchImpl = globalThis.fetch, hosted = undefined, maxBody = HTTP_TEXT_MAX_BODY }) {
  if (!HTTP_TEXT_FORMATS.includes(format)) throw new Error(ko_en(`http 러너: 모르는 format "${format}" — ${HTTP_TEXT_FORMATS.join('|')} 중 하나여야 합니다.`, `http runner: unknown format "${format}" — use ${HTTP_TEXT_FORMATS.join('|')}.`));
  const url = await assertHttpTextEndpoint(endpoint, hosted === undefined ? {} : { hosted });
  const keyRaw = cred?.env?.ARGO_HTTP_KEY ? String(cred.env.ARGO_HTTP_KEY).trim() : '';
  const key = keyRaw && keyRaw !== HTTP_TEXT_NO_AUTH ? keyRaw : '';
  const ms = Math.max(1000, Number(timeoutMs) || 30_000);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(new Error('timeout')), ms); // AbortSignal.any 미사용(Node 20.3 미만 셀프호스트, 분리 검수 LOW-4)
  const onOuter = () => ac.abort(new Error('aborted')); if (signal) { if (signal.aborted) onOuter(); else signal.addEventListener('abort', onOuter, { once: true }); }
  const t0 = Date.now();
  const classify = (e) => { // fetch·본문 읽기 어느 단계든 같은 분류 — 헤더 200 뒤 본문이 멈추는 게이트웨이(흔한 실패 모양)도 timedOut(3차 검수 M-B)
    if (signal?.aborted) return Object.assign(new Error('aborted'), { aborted: true });
    if (ac.signal.aborted || Date.now() - t0 >= ms) {
      const cap = ms >= 3_600_000 ? `${Math.round((ms / 3_600_000) * 10) / 10}시간` : `${Math.round((ms / 60_000) * 10) / 10}분`;
      return Object.assign(new Error(ko_en(`시간 초과: 외부 엔진(${new URL(url).host})이 상한 ${cap} 안에 답하지 않았습니다 — 엔드포인트가 살아 있는지, 같은 지시를 다시 보내면 같은 자리에서 멈추는지 확인해 주세요.`, `Timed out: the external engine at ${new URL(url).host} did not answer within the cap.`)), { timedOut: true });
    }
    return null;
  };
  const mask = (s) => (key ? String(s).split(key).join('***') : String(s)); // 엔드포인트가 Authorization을 에코해도 보낸 키가 스레드·이벤트에 남지 않게(3차 검수 L-5)
  try {
    let r;
    try {
      r = await fetchImpl(url, {
        method: 'POST', signal: ac.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/plain', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(buildHttpTextRequest({ format, prompt, model, kind, readOnly })),
      });
    } catch (e) {
      const cls = classify(e); if (cls) throw cls;
      const why = String(e?.cause?.code || e?.cause?.message || e?.name || e?.message || e).replace(/[?&]?(key|token|secret)=[^&\s]+/gi, '');
      throw Object.assign(new Error(`API Error: 0 ${why} (${new URL(url).host})`), { httpStatus: 0 }); // 연결 실패·리다이렉트 거절 — 벤더 거절과 구분되는 status 0
    }
    let raw;
    try {
      if (!r.ok) { const head = await readCapped(r, 4000).catch(() => ''); throw Object.assign(new Error(`API Error: ${r.status} ${mask(head.slice(0, 300)).replace(/\s+/g, ' ')}`), { httpStatus: r.status }); } // 상태 판정이 상한보다 먼저 — 큰 401 본문이 각인을 잃지 않게(LOW-1)
      raw = await readCapped(r, maxBody);
    } catch (e) { // 본문 단계 — 상태·상한 오류는 그대로, 시간 초과·중단은 분류, 그 밖의 네트워크 단절(terminated·ECONNRESET)은 연결 실패와 같은 status 0
      if (e.httpStatus !== undefined || /상한\(/.test(String(e.message))) throw e;
      const cls = classify(e); if (cls) throw cls;
      throw Object.assign(new Error(`API Error: 0 ${mask(String(e?.cause?.code || e?.message || e))} (${new URL(url).host})`), { httpStatus: 0 });
    }
    return parseHttpTextResponse(format, raw).trim();
  } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onOuter); }
}
