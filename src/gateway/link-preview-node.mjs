// 에이전트 답의 링크 미리보기(2026-10-02) — 본체 게이트웨이가 답을 게시하기 전에 첫 링크를 한 번 가져와 meta.link_preview에 싣는다.
// 규칙(SSRF 검사·파싱·길이)은 src/link-preview.mjs(엣지 함수는 같은 내용의 사본)를 쓴다. 여기는 Node 네트워크만.
// 엣지(Deno)와 다른 점: 연결할 때 http(s).request의 lookup 훅이 실제로 붙을 주소를 다시 검사한다 —
// 이름 풀기와 연결 사이에 DNS가 내부 주소로 바뀌는(재바인딩) 틈이 없다. 주인 PC에서 돌므로 사내망·공유기 주소에 닿지 않는 것이 중요하다.
// 부하: 링크가 든 에이전트 답 1건당 외부 요청 최대 4번(리다이렉트 3번 포함), 5초 상한. DB 호출은 늘지 않는다(같은 insert에 실린다).
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { firstUrl, fetchLinkPreview, isBlockedIp, headScanner } from '../link-preview.mjs';

const UA = 'Mozilla/5.0 (compatible; ArgoLinkPreview/1.0; +https://argo.ceo)';

/** http(s).request lookup 훅 — 푼 주소 중 하나라도 막힌 주소면 연결하지 않는다(EBLOCKED). */
export function guardedLookup(hostname, options, cb) {
  const opts = typeof options === 'object' && options ? options : { family: options };
  dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [];
    if (!list.length || list.some((a) => isBlockedIp(a.address))) return cb(Object.assign(new Error(`blocked address for ${hostname}`), { code: 'EBLOCKED' }));
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

const resolveAll = (host) => new Promise((resolve, reject) => dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => a.address)))));

/** 리다이렉트를 따라가지 않는 GET — 3xx·비 HTML은 본문 없이, HTML은 maxBytes까지만 읽고 끊는다. timeoutMs는 전체 상한. */
export function nodeRequest(url, { timeoutMs, maxBytes }, { lookup = guardedLookup } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', lookup, agent: false, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'ko,en;q=0.8' } }, (res) => {
      const headers = { 'content-type': String(res.headers['content-type'] ?? ''), location: String(res.headers.location ?? '') };
      const html = /^(text\/html|application\/xhtml\+xml)\b/i.test(headers['content-type']);
      if (res.statusCode !== 200 || !html) { res.destroy(); return finish(resolve, { status: res.statusCode, headers, body: new Uint8Array() }); }
      const scan = headScanner(maxBytes); // </head>를 만나거나 1MB에 닿으면 멈춘다(엣지 readHead와 같은 규칙)
      const done = () => finish(resolve, { status: res.statusCode, headers, body: scan.bytes() });
      res.on('data', (c) => { if (scan.push(new Uint8Array(c.buffer, c.byteOffset, c.length)) !== 'more') { res.destroy(); done(); } });
      res.on('end', done);
      res.on('error', (e) => finish(reject, e));
      res.on('close', done);
    });
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); finish(reject, new Error('timeout')); }, Math.max(1, timeoutMs));
    req.on('error', (e) => finish(reject, e));
    req.end();
  });
}

/** 답 본문의 첫 링크 카드 — 링크가 없거나 실패하면 null(카드 없음, 다시 시도 없음). */
export async function replyLinkPreview(text, { resolve = resolveAll, request = nodeRequest } = {}) {
  const url = firstUrl(text);
  if (!url) return null;
  return fetchLinkPreview(url, { resolve, request }).catch(() => null);
}
