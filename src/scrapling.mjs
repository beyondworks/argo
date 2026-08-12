// Qwen/OpenAI 호환 러너의 웹 도구 — Scrapling CLI를 제한된 인자로 실행한다.
// 셸 문자열을 만들지 않고 execFile(argv)만 사용해 URL/검색어가 명령으로 해석되지 않게 한다.
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { scrubServerSecrets } from './runners/shared.mjs';

const execFileAsync = promisify(execFile);
const MAX_WEB_CHARS = 120_000;
const MAX_SEARCH_RESULTS = 10;

function ipv4Private(address) {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || p[0] >= 224;
}

function ipv6Segments(address) {
  const convertDottedTail = (part) => {
    if (!part.includes('.')) return [part];
    const octets = part.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [];
    return [((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16)];
  };
  const [leftRaw, rightRaw, extra] = address.split('::');
  if (extra !== undefined) return [];
  const left = leftRaw ? leftRaw.split(':').flatMap(convertDottedTail) : [];
  const right = rightRaw ? rightRaw.split(':').flatMap(convertDottedTail) : [];
  const zeros = rightRaw === undefined ? 0 : 8 - left.length - right.length;
  const parts = rightRaw === undefined ? left : [...left, ...Array(Math.max(0, zeros)).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return [];
  return parts.map((part) => Number.parseInt(part, 16));
}

/** 웹 도구의 SSRF 차단용. loopback/private/link-local/ULA/multicast는 열지 않는다. */
export function isPrivateWebAddress(address) {
  const raw = String(address ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!raw) return true;
  if (isIP(raw) === 4) return ipv4Private(raw);
  if (isIP(raw) !== 6) return true;
  const parts = ipv6Segments(raw);
  if (!parts.length) return true;
  if (parts.slice(0, 7).every((part) => part === 0) && parts[7] <= 1) return true;
  if (parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff) {
    const mapped = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
    return ipv4Private(mapped);
  }
  return (parts[0] & 0xfe00) === 0xfc00
    || (parts[0] & 0xffc0) === 0xfe80
    || (parts[0] & 0xff00) === 0xff00;
}

/** 초기 요청 URL을 공개 HTTP(S) 주소로 제한한다. Scrapling은 redirect를 끈 채 실행한다. */
export async function resolvePublicWebUrl(input, lookupFn = lookup) {
  let url;
  try { url = new URL(String(input ?? '').trim()); } catch { throw new Error('유효한 웹 URL이 필요하다.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('자격이 포함되지 않은 http/https URL만 열 수 있다.');
  }
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) {
    throw new Error('로컬·사설 네트워크 주소는 웹 도구로 열 수 없다.');
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookupFn(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateWebAddress(address))) {
    throw new Error('로컬·사설 네트워크 주소는 웹 도구로 열 수 없다.');
  }
  return { url, address: addresses[0].address };
}

export async function assertPublicWebUrl(input, lookupFn = lookup) {
  return (await resolvePublicWebUrl(input, lookupFn)).url;
}

function childEnv() {
  const env = scrubServerSecrets(process.env, 'deepseeklocal');
  for (const key of Object.keys(env)) {
    if (key.startsWith('ARGO_') || key.startsWith('SUPABASE_') || key.startsWith('NEXT_PUBLIC_')) delete env[key];
  }
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
}

async function pinnedProxy(targetUrl, address) {
  const target = new URL(targetUrl);
  target.hash = '';
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const sockets = new Set();
  const sameTarget = (input) => {
    try {
      const candidate = new URL(input);
      candidate.hash = '';
      return candidate.href === target.href;
    } catch { return false; }
  };
  const server = createServer((req, res) => {
    if (target.protocol !== 'http:' || req.method !== 'GET' || !sameTarget(req.url)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = httpRequest({
      host: address, family: isIP(address), port, method: 'GET',
      path: `${target.pathname}${target.search}`, headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Bad Gateway'); });
    req.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('connect', (req, client, head) => {
    let authority;
    try { authority = new URL(`http://${req.url}`); } catch { client.destroy(); return; }
    if (target.protocol !== 'https:' || authority.hostname.toLowerCase() !== target.hostname.toLowerCase() || Number(authority.port || 80) !== port) {
      client.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      client.destroy();
      return;
    }
    const upstream = netConnect({ host: address, family: isIP(address), port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const localPort = server.address().port;
  return {
    url: `http://127.0.0.1:${localPort}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function scraplingMarkdown(input, { timeoutSeconds = 30, signal = null } = {}) {
  const { url, address } = await resolvePublicWebUrl(input);
  const dir = await mkdtemp(join(tmpdir(), 'argo-scrapling-'));
  const output = join(dir, 'page.md');
  let proxy;
  try {
    // 검증한 DNS 결과로 연결을 고정해, 검증 후 재조회되는 DNS rebinding을 막는다.
    proxy = await pinnedProxy(url, address);
    await execFileAsync(process.env.SCRAPLING_BIN || 'scrapling', [
      'extract', 'get', String(url), output,
      '--timeout', String(Math.max(5, Math.min(60, Math.floor(timeoutSeconds)))),
      '--proxy', proxy.url, '--no-follow-redirects', '--ai-targeted',
    ], { timeout: (timeoutSeconds + 5) * 1000, ...(signal ? { signal } : {}), maxBuffer: 1024 * 1024, env: childEnv() });
    return { url, markdown: (await readFile(output, 'utf8')).slice(0, MAX_WEB_CHARS) };
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Scrapling이 설치되어 있지 않다. `pip install "scrapling[shell]"` 후 다시 시도하라.');
    const detail = String(error?.stderr || error?.message || error).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(`Scrapling 가져오기 실패: ${detail}`);
  } finally {
    await proxy?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function unwrapDuckDuckGo(href) {
  try {
    const url = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : null;
  } catch { return null; }
}

/** Scrapling이 만든 DuckDuckGo Markdown을 모델에 주기 좋은 구조로 축약한다. */
export function parseScraplingSearchMarkdown(markdown, limit = MAX_SEARCH_RESULTS) {
  const links = [...String(markdown ?? '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)];
  const out = [];
  const seen = new Set();
  for (const match of links) {
    const url = unwrapDuckDuckGo(match[2]);
    if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    const title = match[1].replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.startsWith('http') || title.length > 300) continue;
    seen.add(url);
    out.push({ title, url });
    if (out.length >= limit) break;
  }
  return out;
}

export async function scraplingWebSearch(query, { limit = MAX_SEARCH_RESULTS, signal = null } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q) throw new Error('검색어가 필요하다.');
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const { markdown } = await scraplingMarkdown(url, { timeoutSeconds: 30, signal });
  const results = parseScraplingSearchMarkdown(markdown, Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(limit) || MAX_SEARCH_RESULTS)));
  if (!results.length) return `검색 결과가 없다. 검색어: ${q}`;
  return results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}`).join('\n\n');
}

export async function scraplingWebFetch(input, { signal = null } = {}) {
  const { url, markdown } = await scraplingMarkdown(input, { timeoutSeconds: 30, signal });
  return `출처: ${url.href}\n\n${markdown}`;
}
