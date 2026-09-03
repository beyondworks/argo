// 휴대폰 페어링 — "폰 = 이 PC의 화면". 권한의 근거는 WS_ROOT/.mobile.json(기기 파일)이고, 쿠키 argo-mobile은
// 미들웨어 UX 게이트일 뿐이다(gueststate·devicesession과 같은 3중 계약). 회사 폴더 밖이라 동기화 대상이 아니다.
//   enabled / port / upstreamPort — LAN 리스너(mobile-listener.mjs) 설정. 기본 off = 데스크톱 관측 변화 0.
//   pairs[]  — 페어링된 폰. 토큰은 sha256 해시만 저장(원문은 폰 쿠키에만 산다).
//   pending  — 발급 중인 6자리 코드(5분 TTL·5회 오입력·1회 소비). PC 설정 카드가 QR로 띄운다.
// 인증은 Host가 아니라 이 토큰이다 — LAN이든 Tailscale이든 같은 코드로 동작한다(계획 정본 ~/.claude/plans/pc-eventual-steele.md).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { makePairCode } from './connections.mjs';

const FILE = '.mobile.json';
export const MOBILE_COOKIE = 'argo-mobile';
export const MOBILE_PORT_DEFAULT = 3031;
export const CODE_TTL_MS = 5 * 60_000;
export const CODE_MAX_TRIES = 5;
const SEEN_THROTTLE_MS = 5 * 60_000; // lastSeen 갱신은 요청마다가 아니라 5분에 한 번(폴링 3초마다 쓰기 금지)
const EMPTY = Object.freeze({ enabled: false, port: MOBILE_PORT_DEFAULT, upstreamPort: 0, pairs: [], pending: null });

const fileOf = (root) => join(root, FILE);
const lockKey = (root) => `mobile:${root}`;
const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
const norm = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// 루프백 판정 — middleware.js·app/auth.mjs와 같은 정규식(각각 자체 정의: 미들웨어는 edge 번들, auth는 next/headers 의존).
export const isLoopbackHost = (host) => /^(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?$/.test(host || '');

export async function loadMobile({ root = WS_ROOT } = {}) {
  const m = await readJsonLenient(fileOf(root), EMPTY); // 손상 = 페어링 없음(마커는 재생성 가능 — 관용)
  return { ...EMPTY, ...m, pairs: Array.isArray(m.pairs) ? m.pairs : [] };
}
const save = (root, m) => writeJsonAtomic(fileOf(root), m);

export const codeAlive = (p, now = Date.now()) => !!p && typeof p.code === 'string' && now < Number(p.exp);

export async function setMobileEnabled(on, { port, upstreamPort, root = WS_ROOT } = {}) {
  return withLock(lockKey(root), async () => {
    const m = await loadMobile({ root });
    m.enabled = !!on;
    if (Number.isInteger(port) && port > 0) m.port = port;
    if (Number.isInteger(upstreamPort) && upstreamPort > 0) m.upstreamPort = upstreamPort;
    if (!m.enabled) m.pending = null; // 끄면 발급 중 코드도 폐기
    await save(root, m);
    return m;
  });
}

export async function newPairCode({ root = WS_ROOT, now = Date.now() } = {}) {
  return withLock(lockKey(root), async () => {
    const m = await loadMobile({ root });
    m.pending = { code: makePairCode(), exp: now + CODE_TTL_MS, tries: 0 };
    await save(root, m);
    return { code: m.pending.code, exp: m.pending.exp };
  });
}

/** 코드 소비 → 토큰 발급. 반환 { token, pair } | { error: apimsg 코드 }. 락 안에서 판정·저장(동시 두 폰이 같은 코드를 쓰면 한 쪽만 성공). */
export async function consumePairCode(code, { name = '', ua = '', root = WS_ROOT, now = Date.now() } = {}) {
  return withLock(lockKey(root), async () => {
    const m = await loadMobile({ root });
    if (!m.enabled) return { error: 'mobile_disabled' };
    const p = m.pending;
    if (!codeAlive(p, now)) {
      if (p) { m.pending = null; await save(root, m); }
      return { error: 'mobile_code_expired' };
    }
    if (norm(code) !== p.code) {
      p.tries = (p.tries || 0) + 1;
      if (p.tries >= CODE_MAX_TRIES) { m.pending = null; await save(root, m); return { error: 'mobile_code_locked' }; }
      await save(root, m);
      return { error: 'mobile_code_wrong' };
    }
    const token = randomBytes(32).toString('hex');
    const iso = new Date(now).toISOString();
    const pair = { id: randomBytes(6).toString('hex'), hash: hashToken(token), name: String(name).slice(0, 60), ua: String(ua).slice(0, 200), createdAt: iso, lastSeen: iso };
    m.pairs.push(pair);
    m.pending = null; // 1회 소비
    await save(root, m);
    return { token, pair: publicPair(pair) };
  });
}

/** 토큰 검증 — 유효하면 공개 뷰, 아니면 null. 해시 대조는 상수 시간. 토글 off면 기존 토큰도 거절(안전 기본). */
export async function verifyMobileToken(token, { root = WS_ROOT, now = Date.now() } = {}) {
  if (!token) return null;
  const m = await loadMobile({ root });
  if (!m.enabled) return null;
  const h = Buffer.from(hashToken(token));
  const pair = m.pairs.find((p) => typeof p.hash === 'string' && p.hash.length === h.length && timingSafeEqual(Buffer.from(p.hash), h));
  if (!pair) return null;
  if (now - Date.parse(pair.lastSeen || 0) > SEEN_THROTTLE_MS) touch(pair.id, root, now).catch(() => {}); // 표시용 — 실패 무해
  return publicPair(pair);
}
async function touch(id, root, now) {
  await withLock(lockKey(root), async () => {
    const m = await loadMobile({ root });
    const p = m.pairs.find((x) => x.id === id);
    if (!p) return;
    p.lastSeen = new Date(now).toISOString();
    await save(root, m);
  });
}

export async function revokePair(id, { root = WS_ROOT } = {}) {
  return withLock(lockKey(root), async () => {
    const m = await loadMobile({ root });
    const n = m.pairs.length;
    m.pairs = m.pairs.filter((p) => p.id !== id);
    if (m.pairs.length === n) return false;
    await save(root, m);
    return true;
  });
}

export const publicPair = ({ id, name, ua, createdAt, lastSeen }) => ({ id, name, ua, createdAt, lastSeen });
/** API 응답용 — 해시·tries는 내보내지 않는다. */
export function publicView(m, now = Date.now()) {
  return {
    enabled: !!m.enabled, port: m.port, upstreamPort: m.upstreamPort,
    pairs: m.pairs.map(publicPair),
    pending: codeAlive(m.pending, now) ? { code: m.pending.code, exp: m.pending.exp } : null,
  };
}

/** Cookie 헤더에서 argo-mobile 값(마지막 값 채택 — authmsg langFromCookieHeader와 같은 판독 의미). */
export function mobileTokenFromCookie(header) {
  let last = null;
  for (const m of (header || '').matchAll(/(?:^|;\s*)argo-mobile=([^;]*)/g)) last = m[1];
  return last;
}

/** 요청 단위 접근 판정(순수 입력) — currentUser가 쓰는 유일한 판정.
    반환: { kind: 'loopback' } 루프백 Host = 폰 경로 아님(쿠키가 있어도 무시 — 데스크톱 경로 불변)
          { kind: 'none' }     비루프백 + 쿠키 없음 = 종전 경로(호스티드·워커의 쿠키 세션 흐름을 건드리지 않는다)
          { kind: 'mobile', pair } 유효 토큰 / { kind: 'deny' } 쿠키는 있는데 무효(해제·토글 off·위조) */
export async function mobileAccess({ host, cookieHeader, root = WS_ROOT, now = Date.now() } = {}) {
  if (isLoopbackHost(host)) return { kind: 'loopback' };
  const tok = mobileTokenFromCookie(cookieHeader);
  if (!tok) return { kind: 'none' };
  const pair = await verifyMobileToken(tok, { root, now });
  return pair ? { kind: 'mobile', pair } : { kind: 'deny' };
}
