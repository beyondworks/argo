// 링크 미리보기 공통 규칙(2026-10-02 유건 요청) — 엣지 함수(msgr-link-preview)·본체 게이트웨이·앱이 같은 모듈을 쓴다.
// 정본: src/link-preview.mjs(엣지 함수는 supabase/functions/_shared/link-preview.js 사본). 여기서 잠그는 것: 첫 링크 추출, URL 안전 검사(SSRF — 막아야 할 주소 목록),
// OG 파싱, 길이 자르기, 리다이렉트마다 다시 검사, 512KB·HTML만·5초.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  firstUrl, urlSegments, checkUrl, isBlockedIp, parseHtmlPreview, cleanPreview, fetchLinkPreview, decodeHtml, PREVIEW_LIMITS, headScanner, canPreview,
} from '../src/link-preview.mjs';

test('firstUrl — 본문의 첫 http(s) 링크 하나만, 문장 부호는 떼고 괄호 짝은 지킨다', () => {
  assert.equal(firstUrl('보세요 https://example.com/a?b=1. 그리고 https://two.example'), 'https://example.com/a?b=1');
  assert.equal(firstUrl('(https://ko.wikipedia.org/wiki/Seoul_(city))'), 'https://ko.wikipedia.org/wiki/Seoul_(city)');
  assert.equal(firstUrl('링크: http://example.com/path),'), 'http://example.com/path');
  assert.equal(firstUrl('"https://example.com/q"'), 'https://example.com/q');
  assert.equal(firstUrl('<https://example.com/x>'), 'https://example.com/x');
  assert.equal(firstUrl('한글 바로 뒤https://example.com 도'), 'https://example.com');
  assert.equal(firstUrl('없음 ftp://example.com javascript:alert(1) example.com'), null);
  assert.equal(firstUrl('코드 안 `https://in-code.example` 은 건너뛰고 https://out.example'), 'https://out.example');
  assert.equal(firstUrl('```\nhttps://fenced.example\n```'), null);
  assert.equal(firstUrl(''), null);
  assert.equal(firstUrl(null), null);
  assert.equal(firstUrl(`https://example.com/${'a'.repeat(3000)}`), null, '2048자 넘는 링크는 미리보기 대상이 아니다');
});

test('urlSegments — 본문을 글자/링크 조각으로 나눠 링크만 누를 수 있게 한다(HTML 없이)', () => {
  assert.deepEqual(urlSegments('a https://x.example/b. c'), [{ text: 'a ' }, { text: 'https://x.example/b', url: 'https://x.example/b' }, { text: '. c' }]);
  assert.deepEqual(urlSegments('없음'), [{ text: '없음' }]);
  assert.deepEqual(urlSegments('<script>https://x.example</script>'), [{ text: '<script>' }, { text: 'https://x.example', url: 'https://x.example' }, { text: '</script>' }]);
});

// 막아야 할 주소 — 사설·루프백·링크로컬·메타데이터·멀티캐스트·문서용·IPv4 매핑 IPv6·NAT64·6to4
const BLOCKED_IPS = [
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.254', '127.0.0.1', '127.1.2.3', '169.254.169.254', '169.254.0.1',
  '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.5', '192.168.0.1', '192.168.255.255', '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9',
  '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  '::', '::1', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '64:ff9b::127.0.0.1', '2002:7f00:1::', '2002:a9fe:a9fe::1', '2001:db8::1', '100::1',
  '::127.0.0.1', 'not-an-ip', '', '1.2.3', '256.1.1.1',
];
const PUBLIC_IPS = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '192.169.0.1', '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808'];

test('isBlockedIp — 막아야 할 주소는 전부 막고, 공인 주소는 통과', () => {
  for (const ip of BLOCKED_IPS) assert.equal(isBlockedIp(ip), true, `막아야 함: ${ip}`);
  for (const ip of PUBLIC_IPS) assert.equal(isBlockedIp(ip), false, `공인 주소: ${ip}`);
});

test('checkUrl — http(s)만, 자격 정보·이상한 포트·내부 이름·IP 표기 변형을 막는다', () => {
  const ok = ['https://example.com/', 'http://example.com:80/a', 'https://example.com:443', 'https://example.com:8443/x', 'https://8.8.8.8/'];
  for (const u of ok) assert.ok(checkUrl(u), `허용: ${u}`);
  const bad = [
    'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'gopher://example.com',
    'https://user:pw@example.com/', 'https://user@example.com/', 'https://example.com:22/', 'http://example.com:6379/',
    'http://localhost/', 'http://LOCALHOST:80/', 'http://app.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://db.internal/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://10.1.2.3:8080/', 'not a url', '', null,
  ];
  for (const u of bad) assert.equal(checkUrl(u), null, `막아야 함: ${u}`);
});

test('decodeHtml — 이름·숫자 엔티티를 글자로(태그는 만들지 않는다)', () => {
  assert.equal(decodeHtml('A &amp; B &lt;b&gt; &quot;q&quot; &#39;s&#x27; &#54620;&#xAE00; &nbsp;x &unknown;'), 'A & B <b> "q" \'s\' 한글  x &unknown;');
});

test('parseHtmlPreview — og 우선, 없으면 twitter·title·description, 상대 이미지 주소는 절대 주소로', () => {
  const html = `<!doctype html><html><head><meta charset="utf-8">
    <title>문서 제목 &amp; 뒤</title>
    <meta name="description" content="일반 설명">
    <meta property="og:title" content="OG 제목">
    <meta content="OG 설명" property="og:description">
    <meta property='og:image' content='/img/card.png'>
    <meta property="og:site_name" content="예시 사이트">
  </head><body><meta property="og:title" content="본문 안 가짜"></body></html>`;
  assert.deepEqual(parseHtmlPreview(html, 'https://example.com/post/1'), { title: 'OG 제목', description: 'OG 설명', image: 'https://example.com/img/card.png', site: '예시 사이트' });
  const plain = '<html><head><title>  그냥\n 제목 </title><meta name="twitter:description" content="트위터 설명"><meta name="twitter:image" content="https://cdn.example/x.jpg"></head></html>';
  assert.deepEqual(parseHtmlPreview(plain, 'https://example.com/'), { title: '그냥 제목', description: '트위터 설명', image: 'https://cdn.example/x.jpg', site: '' });
  assert.deepEqual(parseHtmlPreview('<p>no head</p>', 'https://example.com/'), { title: '', description: '', image: '', site: '' });
});

test('cleanPreview — 길이를 자르고 제어 문자를 지우며, 제목도 설명도 없으면 카드를 만들지 않는다', () => {
  const p = cleanPreview({ url: 'https://example.com/a', title: `제목\u0000‮${'가'.repeat(400)}`, description: 'd'.repeat(900), image: 'https://example.com/i.png', site: 's'.repeat(200) });
  assert.equal(p.v, 1);
  assert.equal(p.url, 'https://example.com/a');
  assert.ok(p.title.length <= PREVIEW_LIMITS.title && !/[\u0000‮]/.test(p.title));
  assert.ok(p.description.length <= PREVIEW_LIMITS.description);
  assert.ok(p.site.length <= PREVIEW_LIMITS.site);
  assert.equal(cleanPreview({ url: 'https://example.com', title: ' ', description: '' }), null);
  assert.equal(cleanPreview({ url: 'https://example.com', title: 't', image: 'http://insecure.example/i.png' }).image, '', 'http 이미지는 앱 CSP·혼합 콘텐츠 때문에 싣지 않는다');
  assert.equal(cleanPreview({ url: 'javascript:alert(1)', title: 't' }), null);
});

// ── 가져오기: 가짜 DNS·가짜 요청으로 SSRF 경로를 고정한다 ──
const enc = (s) => new TextEncoder().encode(s);
const page = (html, headers = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body: enc(html) });
const OG = '<head><meta property="og:title" content="제목"><meta property="og:image" content="https://img.example/a.png"></head>';
function fakeNet(map, dns = {}) {
  const calls = [];
  return {
    calls,
    resolve: async (host) => dns[host] ?? ['93.184.216.34'],
    request: async (url, opts) => { calls.push({ url, opts }); const r = map[url]; if (!r) throw new Error(`no route ${url}`); return typeof r === 'function' ? r(opts) : r; },
  };
}

test('fetchLinkPreview — 정상 페이지: 한 번 가져와 카드 하나', async () => {
  const net = fakeNet({ 'https://example.com/a': page(OG) });
  const p = await fetchLinkPreview('https://example.com/a', net);
  assert.deepEqual(p, { v: 1, url: 'https://example.com/a', title: '제목', description: '', image: 'https://img.example/a.png', site: '' });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].opts.maxBytes, 1024 * 1024, '상한 1MB(2026-10-02 총괄 결정)');
  assert.ok(net.calls[0].opts.timeoutMs <= 5000 && net.calls[0].opts.timeoutMs > 0);
});

test('fetchLinkPreview — DNS가 내부 주소를 돌려주면 요청하지 않는다(이름은 공인처럼 보여도)', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fd00::2']) {
    const net = fakeNet({ 'https://evil.example/': page(OG) }, { 'evil.example': ['93.184.216.34', ip] });
    assert.equal(await fetchLinkPreview('https://evil.example/', net), null, ip);
    assert.equal(net.calls.length, 0, `요청이 나가면 안 됨: ${ip}`);
  }
  const empty = fakeNet({ 'https://nx.example/': page(OG) }, { 'nx.example': [] });
  assert.equal(await fetchLinkPreview('https://nx.example/', empty), null);
});

test('fetchLinkPreview — 리다이렉트는 최대 3번, 매 홉마다 다시 검사(내부 주소로 튀면 중단)', async () => {
  const hop = (to) => ({ status: 302, headers: { location: to }, body: enc('') });
  const ok = fakeNet({ 'https://a.example/': hop('https://b.example/x'), 'https://b.example/x': hop('/y'), 'https://b.example/y': page(OG) });
  assert.equal((await fetchLinkPreview('https://a.example/', ok)).title, '제목');
  assert.equal(ok.calls.length, 3);
  const toInternal = fakeNet({ 'https://a.example/': hop('http://169.254.169.254/latest') });
  assert.equal(await fetchLinkPreview('https://a.example/', toInternal), null);
  assert.equal(toInternal.calls.length, 1);
  const toInternalName = fakeNet({ 'https://a.example/': hop('https://rebind.example/') }, { 'rebind.example': ['192.168.0.10'] });
  assert.equal(await fetchLinkPreview('https://a.example/', toInternalName), null);
  assert.equal(toInternalName.calls.length, 1);
  const toFile = fakeNet({ 'https://a.example/': hop('file:///etc/passwd') });
  assert.equal(await fetchLinkPreview('https://a.example/', toFile), null);
  const loop = fakeNet({ 'https://l.example/1': hop('/2'), 'https://l.example/2': hop('/3'), 'https://l.example/3': hop('/4'), 'https://l.example/4': hop('/5'), 'https://l.example/5': page(OG) });
  assert.equal(await fetchLinkPreview('https://l.example/1', loop), null, '4번째 리다이렉트는 따라가지 않는다');
  assert.equal(loop.calls.length, 4);
});

test('fetchLinkPreview — HTML만 파싱, 실패는 카드 없음(null)', async () => {
  assert.equal(await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': page(OG, { 'content-type': 'image/png' }) })), null);
  assert.equal(await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': page(OG, { 'content-type': 'application/json' }) })), null);
  assert.equal(await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': { status: 404, headers: { 'content-type': 'text/html' }, body: enc(OG) } })), null);
  assert.equal(await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': () => { throw new Error('timeout'); } })), null);
  assert.equal(await fetchLinkPreview('http://127.0.0.1/', fakeNet({})), null);
  assert.equal(await fetchLinkPreview('not a url', fakeNet({})), null);
});

test('상한 1MB — 큰 스크립트 뒤(900KB 지점) og는 읽는다(유튜브 모양), 1MB 뒤 og는 읽지 않는다(요청기가 상한을 어겨도)', async () => {
  const pad = (n) => `<script>${'x'.repeat(n)}</script>`;
  const youtube = `<head>${pad(900 * 1024)}<meta property="og:title" content="유튜브 제목"></head><body>`;
  assert.equal((await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': page(youtube) }))).title, '유튜브 제목');
  const tooFar = `<head>${pad(1100 * 1024)}<meta property="og:title" content="너무 뒤"></head>`;
  assert.equal(await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': page(tooFar) })), null, '1MB에서 멈춰 그 뒤 og는 보지 않는다');
});

test('</head> 뒤의 og는 무시한다(본문에 끼운 가짜 카드)', async () => {
  const html = '<head><title>진짜 제목</title></HEAD><body><meta property="og:title" content="본문 가짜"><meta property="og:image" content="https://evil.example/a.png">';
  const p = await fetchLinkPreview('https://x.example/', fakeNet({ 'https://x.example/': page(html) }));
  assert.equal(p.title, '진짜 제목');
  assert.equal(p.image, '');
});

test('headScanner — 조각으로 받아도 </head>(대소문자 무관, 조각 경계에 걸쳐도)를 찾으면 멈추고, 상한을 넘으면 중단', () => {
  const s = headScanner(1024);
  assert.equal(s.push(enc('<html><head><title>a</title></HE')), 'more');
  assert.equal(s.push(enc('AD><body>뒤')), 'done', '조각 경계에 걸친 </HEAD>');
  assert.equal(new TextDecoder().decode(s.bytes()), '<html><head><title>a</title>', '</head> 앞까지만');
  assert.equal(s.push(enc('더')), 'done', '멈춘 뒤에는 더 받지 않는다');
  const big = headScanner(10);
  assert.equal(big.push(enc('<head>12')), 'more');
  assert.equal(big.push(enc('3456789')), 'over');
  assert.equal(big.bytes().length, 10);
  assert.equal(big.push(enc('x')), 'over');
});

test('fetchLinkPreview — og:image도 같은 검사(내부 주소·http·자격 정보는 이미지 없이)', async () => {
  const withImg = (src) => page(`<head><meta property="og:title" content="t"><meta property="og:image" content="${src}"></head>`);
  const cases = [['https://169.254.169.254/x.png', ''], ['http://img.example/a.png', ''], ['https://u:p@img.example/a.png', ''], ['https://internal-img.example/a.png', ''], ['https://img.example/a.png', 'https://img.example/a.png']];
  for (const [src, want] of cases) {
    const net = fakeNet({ 'https://x.example/': withImg(src) }, { 'internal-img.example': ['10.0.0.9'] });
    assert.equal((await fetchLinkPreview('https://x.example/', net)).image, want, src);
  }
});

test('fetchLinkPreview — 5초 안에 끝나지 않으면 중단(남은 시간을 요청기에 넘긴다)', async () => {
  let t = 0;
  const net = fakeNet({ 'https://a.example/': () => { t += 4000; return { status: 301, headers: { location: 'https://b.example/' }, body: enc('') }; }, 'https://b.example/': (o) => { assert.ok(o.timeoutMs <= 1000, `남은 시간 ${o.timeoutMs}`); t += 2000; return page(OG); } });
  assert.equal(await fetchLinkPreview('https://a.example/', { ...net, now: () => t }), null, '전체 5초를 넘긴 응답은 버린다');
});

test('fetchLinkPreview — 문자 집합(euc-kr)을 헤더·meta에서 읽어 해석', async () => {
  // "한글" in EUC-KR = c7 d1 b1 db
  const head = enc('<head><meta charset="euc-kr"><meta property="og:title" content="');
  const tail = enc('"></head>');
  const body = new Uint8Array([...head, 0xc7, 0xd1, 0xb1, 0xdb, ...tail]);
  const net = fakeNet({ 'https://kr.example/': { status: 200, headers: { 'content-type': 'text/html' }, body } });
  assert.equal((await fetchLinkPreview('https://kr.example/', net)).title, '한글');
});

// 검수(2026-10-02) LOW — 일회용 링크 소진: 로그인·인증·초대 링크를 서버가 대신 열면 받는 사람이 쓸 링크가 먼저 소진될 수 있다.
test('canPreview·fetchLinkPreview — 쿼리에 token·code·auth 같은 이름이 있으면 열지 않는다(리다이렉트로 가는 곳도), 그 밖은 그대로', async () => {
  for (const u of ['https://app.example/login?token=abc', 'https://idp.example/cb?code=123&state=x', 'https://x.example/?Auth=1', 'https://x.example/?access_token=a',
    'https://s3.example/o?X-Amz-Signature=ab', 'https://x.example/r?key=1', 'https://x.example/reset?otp=9', 'https://x.example/?session_id=1', 'https://x.example/v?magic=1']) {
    assert.equal(canPreview(u), false, u);
    const net = fakeNet({ [u]: page(OG) });
    assert.equal(await fetchLinkPreview(u, net), null, u);
    assert.equal(net.calls.length, 0, `요청이 나가면 안 됨: ${u}`);
  }
  for (const u of ['https://www.youtube.com/watch?v=abc&si=x', 'https://example.com/a?keyword=b&page=2', 'https://news.example/a#token=1']) assert.equal(canPreview(u), true, u);
  assert.equal(canPreview('http://127.0.0.1/'), false, '주소 검사는 그대로');
  assert.equal(canPreview(null), false);
  const hop = { status: 302, headers: { location: 'https://idp.example/cb?code=1' }, body: enc('') };
  const net = fakeNet({ 'https://a.example/': hop, 'https://idp.example/cb?code=1': page(OG) });
  assert.equal(await fetchLinkPreview('https://a.example/', net), null);
  assert.equal(net.calls.length, 1, '리다이렉트로 가는 일회용 주소는 열지 않는다');
});
