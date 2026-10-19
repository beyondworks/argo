// 외부 봇 호출기 — 메신저 v2 A+(2026-10-19 유건 승인, 볼트 2026-10-19-msgr-lite-scope.md "A+" 절, 위험 R8).
// 헤르메스·오픈클로는 자기 도구 루프를 가진 완성형 에이전트라 러너로 넣지 않는다(넣으면 Argo 권한 게이트를 우회한다). 대신 '외부 봇'으로 두고,
// 사람이 회의방·1:1에서 이름으로 불렀을 때만 이 PC의 Argo가 그 봇의 로컬 HTTP를 한 번 부른다. 우리 서버(Supabase)는 거치지 않는다 — 쉬는 동안 요청 0.
//
//   헤르메스  POST <url>/v1/responses        (기본 http://127.0.0.1:8642) Bearer API_SERVER_KEY, 세션 X-Hermes-Session-Id, 답 = output[type=message].content[type=output_text].text
//   오픈클로  POST <url>/v1/chat/completions (기본 http://127.0.0.1:18789) Bearer 게이트웨이 토큰, 세션 x-openclaw-session-key, model 'openclaw', 답 = choices[0].message.content
//   (형식 근거: hermes-agent.nousresearch.com docs api-server, docs.openclaw.ai gateway/openai-http-api — 2026-10-19 확인. 실호출 미검증: 설치본 없음)
//
// 지키는 것
// - 주소: 루프백(127.0.0.0/8·::1·localhost)과 Tailscale(100.64.0.0/10·fd7a:115c:a1e0::/48·*.ts.net)만. 공개 주소는 거절한다(R8 — 오픈클로 토큰은 운영자 전권).
//   이름 주소는 연결할 때 고른 IP를 다시 검사한다(요청의 lookup을 이 검사로 바꿔 끼운다 — 검사와 연결 사이에 DNS가 바뀌어도 공개 IP로 붙지 않는다). 리다이렉트는 따라가지 않는다.
// - 키: 회사의 기기 로컬 자격 파일(.connector-secrets.json, 동기화 제외 — sync.mjs EXCLUDE)의 extBots 칸. 목록·오류에는 키를 싣지 않는다.
// - 속도: 봇마다 동시 1(줄 세움), 분당 6회(넘으면 바로 거절 — 기다리며 쌓지 않는다). 429면 Retry-After(최대 30초)를 지키고 1번만 다시 부른다.
// - 연쇄: 사람 글 1개당 봇 턴 합계 ≤ 4, hop ≤ 2(budget 객체를 호출부가 사람 글마다 하나 만든다). 봇 글은 다른 봇을 깨우지 않는다(회의 실행기 runRoomCore가 반응 라운드에서 봇을 뺀다).
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { withLock } from './mutex.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';

export const EXT_BOT_KINDS = Object.freeze({
  hermes: Object.freeze({ label: 'Hermes', defaultUrl: 'http://127.0.0.1:8642', path: '/v1/responses' }),
  openclaw: Object.freeze({ label: 'OpenClaw', defaultUrl: 'http://127.0.0.1:18789', path: '/v1/chat/completions' }),
});
export const BOT_LIMITS = Object.freeze({ perMinute: 6, concurrent: 1, turnsPerMessage: 4, hops: 2, retry429: 1, retryAfterMaxMs: 30_000, timeoutMs: 900_000, replyMaxBytes: 1024 * 1024, textMax: 20_000 });

const botErr = (code, message = code) => Object.assign(new Error(message), { code });

// ── 주소 판정 ────────────────────────────────────────────────────────────────
function v4ToInt(ip) { return ip.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0; }
function inV4(ip, base, bits) { const m = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0; return (v4ToInt(ip) & m) === (v4ToInt(base) & m); }
function v6Groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const n = v4ToInt(v4[1]); s = s.replace(v4[1], `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`); }
  const [h, t = ''] = s.split('::');
  const head = h ? h.split(':') : []; const tail = s.includes('::') ? (t ? t.split(':') : []) : [];
  const fill = s.includes('::') ? Array(8 - head.length - tail.length).fill('0') : [];
  return [...head, ...fill, ...tail].map((g) => parseInt(g || '0', 16));
}
/** 봇에 붙어도 되는 IP인가 — 루프백 또는 Tailscale. 그 밖(사설망 192.168·10.x 포함)은 거절한다: 같은 와이파이의 남이 키를 보고 오픈클로 전권을 쓸 수 있다. */
export function isAllowedBotIp(ip) {
  const v = net.isIP(String(ip ?? ''));
  if (v === 4) return inV4(ip, '127.0.0.0', 8) || inV4(ip, '100.64.0.0', 10);
  if (v === 6) {
    const g = v6Groups(ip);
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) { const n = (g[6] << 16 >>> 0) + g[7]; return isAllowedBotIp(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`); } // ::ffff:a.b.c.d
    return g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0; // Tailscale ULA fd7a:115c:a1e0::/48
  }
  return false;
}
/** 봇 주소 검사(저장·호출 모두) — http(s)만, 주소 안 자격 금지, 호스트는 허용 IP·localhost·*.ts.net만. 반환 { ok, url } 또는 { ok:false, code }. */
export function checkBotUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { return { ok: false, code: 'bad_url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'bad_url' };
  if (u.username || u.password) return { ok: false, code: 'bad_url' };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return isAllowedBotIp(host) ? { ok: true, url: u } : { ok: false, code: 'public_address' };
  if (host === 'localhost' || host.endsWith('.localhost') || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return { ok: true, url: u };
  return { ok: false, code: 'public_address' };
}
/** 연결 직전 이름 풀이 — 고른 주소가 전부 허용 IP일 때만 연결한다(DNS가 공개 IP를 돌려주면 연결 자체를 막는다). */
export function guardedLookup(lookup = dns.lookup) {
  return (hostname, opts, cb) => {
    lookup(hostname, { ...(typeof opts === 'object' ? opts : {}), all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some((a) => !isAllowedBotIp(a.address))) return cb(botErr('public_address'));
      if (opts?.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

// ── 저장(기기 로컬 자격 파일의 extBots 칸) ─────────────────────────────────────
// 파일 이름은 connectors.mjs CONNECTOR_SECRETS_BASE와 같다(시험이 같음을 잠근다). 그 모듈을 부르지 않는 것은 MCP SDK까지 읽지 않으려는 것뿐이다.
export const BOT_SECRETS_BASE = '.connector-secrets.json';
const storeFile = (wsId) => join(paths(wsId).root, BOT_SECRETS_BASE);
const lockStore = (wsId, fn) => withLock(`connector:${wsId}`, fn, { file: storeFile(wsId) }); // 커넥터 저장과 같은 잠금 — 같은 파일을 두 곳이 고쳐 쓰다 덮지 않게
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const pub = (id, b) => ({ id, kind: b.kind, name: b.name, url: b.url, enabled: b.enabled !== false, hasKey: !!b.key });

/** 봇 목록(키 없음). 화면·회의방 참여자 목록이 쓴다. */
export async function listBots(wsId) {
  const s = await readJson(storeFile(wsId), {});
  return Object.entries(s.extBots ?? {}).map(([id, b]) => pub(id, b));
}
/** 봇 추가·수정. key는 넘겼을 때만 바꾼다(빈 문자열 = 지움). 주소가 허용 범위가 아니면 저장하지 않는다. */
export async function saveBot(wsId, { id, kind, name, url, key, enabled } = {}) {
  if (!ID_RE.test(String(id ?? ''))) throw botErr('bad_id');
  if (!EXT_BOT_KINDS[kind]) throw botErr('bad_kind');
  const target = url ?? EXT_BOT_KINDS[kind].defaultUrl;
  const chk = checkBotUrl(target);
  if (!chk.ok) throw botErr(chk.code);
  return lockStore(wsId, async () => {
    const s = await readJson(storeFile(wsId), {});
    const prev = s.extBots?.[id] ?? {};
    const next = { ...prev, kind, name: String(name ?? prev.name ?? EXT_BOT_KINDS[kind].label).replace(/\s+/g, ' ').trim().slice(0, 40) || EXT_BOT_KINDS[kind].label, url: target.replace(/\/+$/, ''), enabled: enabled ?? prev.enabled ?? true };
    if (key !== undefined) { if (key) next.key = String(key); else delete next.key; }
    s.extBots = { ...(s.extBots ?? {}), [id]: next };
    await writeJsonAtomic(storeFile(wsId), s);
    return pub(id, next);
  });
}
export async function removeBot(wsId, id) {
  return lockStore(wsId, async () => {
    const s = await readJson(storeFile(wsId), {});
    if (!s.extBots?.[id]) return { removed: false };
    delete s.extBots[id];
    await writeJsonAtomic(storeFile(wsId), s);
    return { removed: true };
  });
}
async function loadBotSecret(wsId, id) {
  const s = await readJson(storeFile(wsId), {});
  return s.extBots?.[id] ?? null;
}

// ── 속도 제한(프로세스 안, 봇마다) ───────────────────────────────────────────
const gates = new Map(); // `${ws}:${id}` → { chain, calls: [ts] }
function gateFor(key) { let g = gates.get(key); if (!g) { g = { chain: Promise.resolve(), calls: [] }; gates.set(key, g); } return g; }
/** 시험용 — 속도 기록을 비운다. */
export function _resetBotGates() { gates.clear(); }

/** 사람 글 1개에 하나 — 그 글에서 이어지는 봇 턴 합계를 센다. */
export const newBotBudget = () => ({ turns: 0 });

// ── HTTP ─────────────────────────────────────────────────────────────────────
function postJson(url, headers, body, { signal, timeoutMs, lookup }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method: 'POST', signal, timeout: timeoutMs, lookup,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'content-length': data.length, ...headers },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > BOT_LIMITS.replyMaxBytes) { req.destroy(botErr('bot_reply_too_large')); return; } chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(botErr('timeout')));
    req.on('error', (e) => reject(e));
    req.end(data);
  });
}
const retryAfterMs = (h, now) => {
  const v = String(h ?? '').trim();
  if (!v) return 1000;
  const sec = Number(v);
  const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(v) - now;
  return Math.max(0, Math.min(BOT_LIMITS.retryAfterMaxMs, Number.isFinite(ms) ? ms : 1000));
};
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(botErr('cancelled'));
  const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(botErr('cancelled')); };
  signal?.addEventListener?.('abort', onAbort, { once: true });
});

/** 봇 요청 본문·헤더 — 종류별. sessionId는 같은 방·같은 봇이면 같은 값(봇 쪽 대화가 이어진다). */
export function botRequest(kind, { text, sessionId, key }) {
  const auth = { authorization: `Bearer ${key}` };
  if (kind === 'hermes') return { headers: { ...auth, 'x-hermes-session-id': sessionId }, body: { model: 'hermes-agent', input: text } };
  return { headers: { ...auth, 'x-openclaw-session-key': sessionId }, body: { model: 'openclaw', messages: [{ role: 'user', content: text }] } };
}
/** 봇 답에서 글 꺼내기 — 없으면 빈 문자열(호출부가 bot_empty로 다룬다). */
export function botReplyText(kind, json) {
  if (kind === 'hermes') {
    if (typeof json?.output_text === 'string') return json.output_text;
    return (json?.output ?? []).filter((o) => o?.type === 'message')
      .flatMap((o) => (o.content ?? []).filter((c) => c?.type === 'output_text').map((c) => String(c.text ?? ''))).join('\n').trim();
  }
  const c = json?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c.trim() : Array.isArray(c) ? c.map((p) => String(p?.text ?? '')).join('').trim() : '';
}

/**
 * 봇 한 번 부르기. bot = { ws, id }, budget = newBotBudget()(사람 글마다), hop = 이 호출이 사람 글에서 몇 번째 봇 단계인가(1부터).
 * 반환 { text }. 실패는 code를 단 오류: bot_missing·bot_off·no_key·public_address·bad_url·bot_turn_cap·bot_hop_cap·rate_limited·bot_rate_limited(429 두 번)
 *   ·bot_unreachable(봇 꺼짐)·bot_auth(401/403)·bot_http·bot_empty·timeout·cancelled. 오류 글에 키를 싣지 않는다.
 * deps(시험) = { lookup, now, timeoutMs }
 */
export async function callBot(bot, { text, sessionId, signal = null, budget = null, hop = 1 } = {}, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const rec = await loadBotSecret(bot.ws, bot.id);
  if (!rec || !EXT_BOT_KINDS[rec.kind]) throw botErr('bot_missing');
  if (rec.enabled === false) throw botErr('bot_off');
  if (!rec.key) throw botErr('no_key');
  const chk = checkBotUrl(rec.url);
  if (!chk.ok) throw botErr(chk.code);
  if (hop > BOT_LIMITS.hops) throw botErr('bot_hop_cap');
  if (budget && budget.turns >= BOT_LIMITS.turnsPerMessage) throw botErr('bot_turn_cap');
  const g = gateFor(`${bot.ws}:${bot.id}`);
  // 분당 6회 — 판정과 기록을 줄 세우기 전에 한다(줄에서 기다리는 호출도 이미 한 번으로 센다: 동시에 7개가 와도 7번째는 바로 거절)
  const t0 = now();
  g.calls = g.calls.filter((t) => t0 - t < 60_000);
  if (g.calls.length >= BOT_LIMITS.perMinute) throw botErr('rate_limited');
  g.calls.push(t0);
  if (budget) budget.turns += 1;
  const run = async () => {
    if (signal?.aborted) throw botErr('cancelled');
    const url = new URL(chk.url.toString());
    url.pathname = `${chk.url.pathname.replace(/\/+$/, '')}${EXT_BOT_KINDS[rec.kind].path}`; url.search = ''; url.hash = '';
    const { headers, body } = botRequest(rec.kind, { text: String(text ?? '').slice(0, BOT_LIMITS.textMax), sessionId: String(sessionId ?? 'argo').slice(0, 200), key: rec.key });
    const opts = { signal, timeoutMs: deps.timeoutMs ?? BOT_LIMITS.timeoutMs, lookup: guardedLookup(deps.lookup) };
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try { res = await postJson(url, headers, body, opts); }
      catch (e) {
        if (signal?.aborted || e?.name === 'AbortError') throw botErr('cancelled');
        if (e?.code === 'public_address' || e?.code === 'timeout' || e?.code === 'bot_reply_too_large') throw botErr(e.code);
        if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(e?.code)) throw botErr('bot_unreachable');
        throw botErr('bot_http');
      }
      if (res.status === 429 && attempt < BOT_LIMITS.retry429) { await sleep(retryAfterMs(res.headers['retry-after'], now()), signal); continue; }
      if (res.status === 429) throw botErr('bot_rate_limited');
      if (res.status === 401 || res.status === 403) throw botErr('bot_auth');
      if (res.status >= 300) throw botErr('bot_http', `bot_http ${res.status}`); // 3xx(리다이렉트)도 따라가지 않는다
      let json; try { json = JSON.parse(res.text); } catch { throw botErr('bot_http', 'bot_http bad json'); }
      const out = botReplyText(rec.kind, json);
      if (!out) throw botErr('bot_empty');
      return { text: out.slice(0, BOT_LIMITS.textMax) };
    }
  };
  // 봇마다 동시 1 — 앞 호출이 끝나야 다음이 나간다(실패해도 줄은 이어진다)
  const p = g.chain.then(run, run);
  g.chain = p.catch(() => {});
  return p;
}
