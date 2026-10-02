// 링크 미리보기 공통 규칙(2026-10-02 유건 요청, 텔레그램·카카오톡 방식 참고) — 의존성 없는 순수 JS.
// 정본은 src/link-preview.mjs, supabase/functions/_shared/link-preview.js는 바이트까지 같은 사본이다(test/msgr-link-preview-copy.test.mjs가 고정).
//   사본을 두는 이유: 엣지 함수 배포 묶음은 supabase/functions 안만 싣고, 본체 앱 서버 묶음(scripts/stage-cli.mjs)은 src/만 싣는다.
//   고칠 때는 src/link-preview.mjs를 고치고 `cp src/link-preview.mjs supabase/functions/_shared/link-preview.js`로 맞춘다.
// 쓰는 곳 세 군데가 같은 규칙을 쓴다:
//   - 엣지 함수 supabase/functions/msgr-link-preview(Deno, 사본) — 사람이 보낸 글. 보내는 기기가 한 번 부른다.
//   - 본체 게이트웨이 src/gateway/link-preview-node.mjs(Node, 정본) — 에이전트 글. 보내기 전에 한 번 가져와 meta에 넣는다.
//   - 메신저 앱 apps/messenger(정본) — 본문 링크를 누를 수 있게 나누기(urlSegments)·보낼 글에 링크가 있는지(firstUrl)만.
// 가져오기는 네트워크를 직접 하지 않는다: resolve(host)·request(url, {timeoutMs, maxBytes})를 호출자가 넣는다
// (Deno는 Deno.resolveDns + fetch, Node는 연결 시점 주소 검사가 되는 http(s).request). 테스트: test/msgr-link-preview.test.mjs.
//
// 보안(SSRF) 규칙 — 서버가 남의 주소를 대신 열어 주는 기능이라 내부망·클라우드 메타데이터에 닿으면 안 된다:
//   http(s)만 · 자격 정보(user:pw@) 금지 · 포트는 80/443/8080/8443만 · 점 없는 이름·localhost·.local·.internal 금지 ·
//   DNS로 얻은 주소 전부가 공인 주소일 때만 요청 · 리다이렉트는 최대 3번, 매번 같은 검사 · 응답은 </head>를 만나면 멈추고 1MB까지만 읽어 HTML만 파싱 ·
//   전체 5초 · og:image도 같은 검사(https만 — 앱 CSP img-src와 혼합 콘텐츠) · 결과 문자열은 길이를 자르고 제어 문자를 지운다.

// 읽기 상한 1MB + </head>에서 멈춤(2026-10-02 총괄 결정) — 유튜브는 og 태그가 큰 스크립트 뒤 710KB 지점에 있어 512KB로는 카드가 안 생겼다.
// 카드 재료(og·title)는 head 안에만 있으므로 </head>를 받으면 더 읽지 않는다 — 대부분의 페이지는 수십 KB에서 끝난다.
export const PREVIEW_LIMITS = Object.freeze({ maxBytes: 1024 * 1024, timeoutMs: 5000, maxRedirects: 3, url: 2048, title: 200, description: 300, site: 80 });

const HEAD_END = [0x3c, 0x2f, 0x68, 0x65, 0x61, 0x64]; // "</head" (소문자 비교)
/**
 * 조각으로 받는 응답에서 </head>를 찾는 읽기 도우미 — Deno 스트림(엣지)·Node 응답(게이트웨이)이 같이 쓴다.
 * push(조각) → 'more'(더 읽기) | 'done'(</head>를 찾음 — 멈춘다) | 'over'(상한 — 멈춘다). bytes() → </head> 앞까지(못 찾았으면 받은 만큼, 상한 이하).
 */
export function headScanner(maxBytes = PREVIEW_LIMITS.maxBytes) {
  const chunks = []; let n = 0; let end = -1; let tail = new Uint8Array(0);
  const lower = (b) => (b >= 0x41 && b <= 0x5a ? b + 32 : b);
  return {
    push(chunk) {
      if (end >= 0) return 'done';
      if (n >= maxBytes) return 'over';
      const c = (chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)).subarray(0, maxBytes - n);
      const win = new Uint8Array(tail.length + c.length); win.set(tail); win.set(c, tail.length);
      for (let i = 0; i + HEAD_END.length <= win.length; i += 1) {
        let hit = true;
        for (let k = 0; k < HEAD_END.length; k += 1) if (lower(win[i + k]) !== HEAD_END[k]) { hit = false; break; }
        if (hit) { end = n - tail.length + i; break; }
      }
      chunks.push(c); n += c.length;
      tail = win.subarray(Math.max(0, win.length - (HEAD_END.length - 1)));
      if (end >= 0) return 'done';
      return n >= maxBytes ? 'over' : 'more';
    },
    bytes() {
      const all = new Uint8Array(n); let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      return end >= 0 ? all.subarray(0, end) : all;
    },
  };
}
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

// ── 본문에서 링크 찾기 ──
// 링크 글자는 ASCII URL 문자만 — "https://example.com에서"처럼 한글 조사가 붙어 쓰는 경우가 흔하다. 작은따옴표·백틱은 인용으로 본다.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/gi;
const TRAIL = /[.,;:!?]/;
function trimUrl(s) {
  let out = s;
  for (;;) {
    const last = out.at(-1);
    if (!last) break;
    if (TRAIL.test(last)) { out = out.slice(0, -1); continue; }
    const pair = { ')': '(', ']': '[' }[last];
    if (pair && count(out, last) > count(out, pair)) { out = out.slice(0, -1); continue; }
    break;
  }
  return out;
}
const count = (s, ch) => s.split(ch).length - 1;
function* urlMatches(text) {
  for (const m of String(text ?? '').matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (/^https?:\/\/[^/?#]/i.test(url)) yield { index: m.index, url };
  }
}

/** 본문의 첫 http(s) 링크 — 코드(``` 울타리·`인라인`) 안은 건너뛴다. 2048자를 넘으면 미리보기 대상이 아니다(null). */
export function firstUrl(text) {
  const plain = String(text ?? '').replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const { url } of urlMatches(plain)) return url.length > PREVIEW_LIMITS.url ? null : url;
  return null;
}

/** 본문을 [{ text }, { text, url }] 조각으로 — 화면은 조각을 글자로만 그린다(HTML로 넣지 않는다). */
export function urlSegments(text) {
  const s = String(text ?? '');
  const out = [];
  let at = 0;
  for (const { index, url } of urlMatches(s)) {
    if (index > at) out.push({ text: s.slice(at, index) });
    out.push({ text: url, url });
    at = index + url.length;
  }
  if (at < s.length || !out.length) out.push({ text: s.slice(at) });
  return out;
}

// ── 주소 검사 ──
function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}
function blockedV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 // 이 망·사설·루프백·멀티캐스트·예약(240/4)·브로드캐스트
    || (a === 100 && b >= 64 && b <= 127)              // CGNAT 100.64/10
    || (a === 169 && b === 254)                        // 링크로컬·클라우드 메타데이터
    || (a === 172 && b >= 16 && b <= 31)               // 사설 172.16/12
    || (a === 192 && b === 168)                        // 사설 192.168/16
    || (a === 192 && b === 0 && (c === 0 || c === 2))  // IETF 192.0.0/24 · 문서용 192.0.2/24
    || (a === 198 && (b === 18 || b === 19))           // 벤치마크 198.18/15
    || (a === 198 && b === 51 && c === 100)            // 문서용
    || (a === 203 && b === 0 && c === 113);            // 문서용
}
function parseV6(input) {
  let s = input.replace(/%.*$/, '').toLowerCase(); // 영역 표시(fe80::1%en0)는 뗀다
  let tail = [];
  const m = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s); // 끝의 IPv4 표기(::ffff:1.2.3.4)
  if (m) {
    const b = parseV4(m[2]);
    if (!b) return null;
    tail = [(b[0] << 8) | b[1], (b[2] << 8) | b[3]];
    s = m[1].endsWith('::') ? m[1] : m[1].slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (x) => (x ? x.split(':') : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  if ([...head, ...rest].some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null;
  const need = 8 - tail.length;
  const n = head.length + rest.length;
  if (halves.length === 1 ? n !== need : n > need - 1) return null;
  const fill = halves.length === 2 ? Array(need - n).fill('0') : [];
  return [...head, ...fill, ...rest].map((h) => parseInt(h, 16)).concat(tail);
}
const v4of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** 막아야 할 주소인가 — 읽을 수 없는 값도 막는다(true). DNS 결과·URL 호스트 둘 다 여기로 온다. */
export function isBlockedIp(ip) {
  const s = String(ip ?? '').trim().replace(/^\[|\]$/g, '');
  const b4 = parseV4(s);
  if (b4) return blockedV4(b4);
  if (!s.includes(':')) return true;
  const w = parseV6(s);
  if (!w || w.length !== 8) return true;
  const zero = (n) => w.slice(0, n).every((x) => x === 0);
  if (zero(8)) return true;                                        // ::
  if (zero(7) && w[7] === 1) return true;                          // ::1
  if (zero(5) && w[5] === 0xffff) return blockedV4(v4of(w[6], w[7])); // IPv4 매핑 ::ffff:a.b.c.d
  if (zero(6)) return blockedV4(v4of(w[6], w[7]));                 // IPv4 호환(폐기) ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return blockedV4(v4of(w[6], w[7])); // NAT64
  if (w[0] === 0x2002) return blockedV4(v4of(w[1], w[2]));         // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true;                     // 고유 로컬 fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // 링크로컬·사이트로컬
  if ((w[0] & 0xff00) === 0xff00) return true;                     // 멀티캐스트
  if (w[0] === 0x2001 && (w[1] === 0x0db8 || w[1] === 0)) return true; // 문서용·Teredo(주소 안에 감춘 IPv4)
  if (w[0] === 0x0100 && w.slice(1, 4).every((x) => x === 0)) return true; // 버림용 100::/64
  return false;
}
const isIpLiteral = (h) => !!parseV4(h) || h.includes(':');
const BLOCKED_NAME = /(^|\.)(localhost|local|internal|localdomain|home\.arpa|lan|intranet)$/;

/** 문법 검사 — 통과하면 URL 객체, 아니면 null. DNS는 보지 않는다(fetchLinkPreview가 따로 본다). */
export function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > PREVIEW_LIMITS.url) return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!ALLOWED_PORTS.has(u.port)) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return null;
  if (isIpLiteral(host)) return isBlockedIp(host) ? null : u; // URL이 2130706433·0x7f.1 같은 표기를 이미 점 네 개로 바꿔 둔다
  if (!host.includes('.') || BLOCKED_NAME.test(host)) return null; // 점 없는 이름은 검색 도메인으로 내부 이름이 된다
  return u;
}

async function publicHost(u, resolve) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIpLiteral(host)) return !isBlockedIp(host);
  let addrs;
  try { addrs = await resolve(host); } catch { return false; }
  const list = (addrs ?? []).map((a) => (typeof a === 'string' ? a : a?.address)).filter(Boolean);
  return list.length > 0 && list.every((a) => !isBlockedIp(a));
}

// ── HTML 읽기 ──
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** HTML 엔티티를 글자로 — 결과는 글자로만 그리므로 태그가 되지 않는다. */
export function decodeHtml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? all;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
  });
}
const squash = (s) => decodeHtml(s).replace(/\s+/g, ' ').trim();
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** head 안의 og·twitter·title·description — body에 끼운 가짜 meta는 보지 않는다. */
export function parseHtmlPreview(html, baseUrl) {
  const src = String(html ?? '');
  const end = src.search(/<\/head\s*>|<body[\s>]/i);
  const head = end >= 0 ? src.slice(0, end) : src;
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = {};
    for (const m of tag.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (key && attrs.content != null && !(key in meta)) meta[key] = attrs.content;
  }
  const pick = (...keys) => { for (const k of keys) { const v = squash(meta[k] ?? ''); if (v) return v; } return ''; };
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? '';
  let image = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  if (image) { try { image = new URL(image, baseUrl).href; } catch { image = ''; } }
  return {
    title: pick('og:title', 'twitter:title') || squash(titleTag),
    description: pick('og:description', 'twitter:description', 'description'),
    image,
    site: pick('og:site_name'),
  };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
function clip(s, n) {
  const chars = Array.from(String(s ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim());
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
}

/** 저장할 카드 모양 { v:1, url, title, description, image, site } — 제목도 설명도 없으면 null(카드 없음). */
export function cleanPreview(p) {
  if (!p || !checkUrl(p.url)) return null;
  const title = clip(p.title, PREVIEW_LIMITS.title);
  const description = clip(p.description, PREVIEW_LIMITS.description);
  if (!title && !description) return null;
  const img = typeof p.image === 'string' ? checkUrl(p.image) : null;
  return { v: 1, url: p.url, title, description, image: img && img.protocol === 'https:' ? img.href : '', site: clip(p.site, PREVIEW_LIMITS.site) };
}

function header(res, name) {
  const h = res?.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) ?? '';
  return h[name] ?? h[name.toLowerCase()] ?? '';
}
function decodeBody(body, ctype) {
  if (typeof body === 'string') return body.slice(0, PREVIEW_LIMITS.maxBytes);
  // 요청기가 이미 </head>·1MB에서 멈췄어도 한 번 더 — 요청기가 규칙을 어겨도 여기서 같은 결과가 나온다
  const scan = headScanner(PREVIEW_LIMITS.maxBytes);
  scan.push(body instanceof Uint8Array ? body : new Uint8Array(body ?? []));
  const bytes = scan.bytes();
  let charset = /charset=["']?([\w-]+)/i.exec(ctype)?.[1];
  if (!charset) {
    const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

/**
 * 링크 하나를 가져와 카드로. 실패는 전부 null(카드 없음, 다시 시도 없음).
 * net: { resolve(host) → [주소], request(url, { timeoutMs, maxBytes }) → { status, headers, body(Uint8Array|string) }, now? }
 * request는 리다이렉트를 따라가지 않아야 한다(3xx를 그대로 돌려준다) — 홉마다 여기서 다시 검사한다.
 */
export async function fetchLinkPreview(url, { resolve, request, now = Date.now } = {}) {
  const start = now();
  let cur = checkUrl(url);
  if (!cur || !resolve || !request) return null;
  for (let hop = 0; ; hop += 1) {
    if (!(await publicHost(cur, resolve))) return null;
    const left = PREVIEW_LIMITS.timeoutMs - (now() - start);
    if (left <= 0) return null;
    let res;
    try { res = await request(cur.href, { timeoutMs: left, maxBytes: PREVIEW_LIMITS.maxBytes }); } catch { return null; }
    if (now() - start > PREVIEW_LIMITS.timeoutMs) return null;
    const status = Number(res?.status);
    if (status >= 300 && status < 400) {
      if (hop >= PREVIEW_LIMITS.maxRedirects) return null;
      const loc = header(res, 'location');
      let next;
      try { next = new URL(loc, cur).href; } catch { return null; }
      cur = loc ? checkUrl(next) : null;
      if (!cur) return null;
      continue;
    }
    if (status < 200 || status > 299) return null;
    const ctype = String(header(res, 'content-type')).toLowerCase();
    if (!/^(text\/html|application\/xhtml\+xml)\b/.test(ctype)) return null;
    const parsed = parseHtmlPreview(decodeBody(res.body, ctype), cur.href);
    if (parsed.image) {
      const iu = checkUrl(parsed.image);
      if (!iu || iu.protocol !== 'https:' || !(await publicHost(iu, resolve))) parsed.image = '';
    }
    return cleanPreview({ url, ...parsed });
  }
}
