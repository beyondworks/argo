// E2EE 단계 0 — 기기 키쌍(X25519)·계정 DEK 로컬 보관·DEK 랩/언랩·기기 공개키 등록.
// 설계 정본: 루트 E2EE-DESIGN.md(§4~§7). 원칙: 서버에는 공개키와 암호문(랩)만 — 평문 열쇠는
// 어떤 형태로도 서버에 두지 않는다(account_keys 평문 구조와의 근본 차이).
//
// 파일: WS_ROOT/.device-e2ee.json (0600) — 회사 폴더 밖이라 동기화 엔진이 걷지 않는다
// (.device-session.json과 동일 원칙: 기기 로컬 상태). { pub, priv, dek? } 전부 base64.
// dek는 이 계정의 데이터 키 — 켜는 기기가 생성하거나(P1), 기기 승인으로 수신하면 여기 저장된다.
// 단계 0에서는 keypair 생성·등록까지만 실사용되고 dek는 비어 있다(동작 불변).
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withLock } from './mutex.mjs';
import { WS_ROOT } from './workspace.mjs';

const FILE = '.device-e2ee.json';
const fileOf = (root) => join(root, FILE);

// X25519 raw(32B) ↔ DER 고정 프리픽스 — Node KeyObject는 DER/JWK만 받으므로 상수로 감싼다.
// 값은 RFC 8410의 AlgorithmIdentifier 고정 인코딩(키와 무관한 구조 바이트라 시크릿 아님).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');   // + raw pub 32B
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // + raw priv 32B
export const rawToPublicKey = (raw32) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' });
const rawToPrivateKey = (raw32) => createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw32]), format: 'der', type: 'pkcs8' });
const publicKeyToRaw = (keyObj) => keyObj.export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length);
const privateKeyToRaw = (keyObj) => keyObj.export({ format: 'der', type: 'pkcs8' }).subarray(PKCS8_PREFIX.length);

let cache = null; // { root, state } — devicesession.mjs와 같은 root-키 캐시 패턴
let dekBuf = null; // 동기 캐시 — secretbox가 동기 함수라 여기서 읽는다(accountKey 패턴)

async function writeTmp(state, root) {
  await mkdir(root, { recursive: true });
  // 생성 시점부터 0600 — 개인키·DEK가 기본 모드로 노출되는 창을 없앤다(synccreds와 동일)
  const tmp = join(root, `.tmp-e2ee-${process.pid}-${Date.now().toString(36)}`);
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  return tmp;
}

function readState(root) {
  let raw = null;
  try { raw = readFileSync(fileOf(root), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw == null) return null;
  const d = JSON.parse(raw); // 손상 = throw — 조용한 키 재생성은 기존 랩(wrapped_deks)을 전부 무효화한다
  if (!d.pub || !d.priv) throw new Error('기기 E2EE 키 파일 손상 — pub/priv 누락');
  return d;
}

/** 기기 E2EE 상태 로드 — 없으면 X25519 키쌍을 만들어 저장(최초 1회). 손상 시 재생성하지 않고 throw —
    조용한 키 교체는 기존 랩(wrapped_deks)을 전부 못 열게 만든다(정직 실패가 안전 방향).
    경합 방어(분리 검수 HIGH — 2026-08-14 기기 세션 사고와 동일 계열, 상주:3001 + 앱 사이드카가 같은
    WS_ROOT에서 동시 기동): 인프로세스는 withLock, 크로스 프로세스는 **create-exclusive 승자 결정** —
    tmp에 쓴 뒤 link()로 목적지에 결합한다. link는 목적지가 이미 있으면 원자적으로 EEXIST라 승자가
    정확히 하나이고, 패자는 자기 키를 버리고 디스크의 승자 키를 재독·채택한다(고아 키 금지).
    mkdir 락 방식과 달리 크래시 잔재(stale lock) 회수 문제가 아예 없다. */
export async function loadDeviceE2ee({ root = WS_ROOT } = {}) {
  if (cache && cache.root === root) return cache.state;
  return withLock(`e2ee:${root}`, async () => {
    if (cache && cache.root === root) return cache.state; // 락 대기 중 다른 호출이 이미 로드했을 수 있다
    let state = readState(root);
    if (!state) {
      const { publicKey, privateKey } = generateKeyPairSync('x25519');
      const fresh = { v: 1, pub: publicKeyToRaw(publicKey).toString('base64'), priv: privateKeyToRaw(privateKey).toString('base64') };
      const tmp = await writeTmp(fresh, root);
      try {
        await link(tmp, fileOf(root)); // 원자적 create-exclusive — 승자 하나만 성공
        state = fresh;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        state = readState(root); // 패자 — 승자(다른 프로세스)의 키를 채택, 내 생성분은 폐기
        if (!state) throw e; // 극단 레이스(승자 파일이 사라짐) — 조용한 재생성 대신 정직 실패
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
    cache = { root, state };
    dekBuf = state.dek ? Buffer.from(state.dek, 'base64') : null;
    return state;
  });
}

/** 동기 DEK 접근 — secretbox 전용(accountKey와 동일 계약). 미보유면 null. */
export const dek = () => dekBuf;

/** DEK 수신·보관(P1: 켜기·기기 승인·복구 코드 경로가 호출). 디스크와 캐시를 함께 갱신.
    락 + 디스크 재독 병합(2026-08-14 원칙) — 캐시 기반 덮어쓰기는 다른 프로세스가 막 쓴 dek를 지운다.
    DEK는 계정당 하나라 동시 수신은 같은 값이지만, 재독이 그 가정 없이도 안전하게 만든다. */
export async function setDek(buf, { root = WS_ROOT } = {}) {
  await loadDeviceE2ee({ root }); // 키쌍 보장(최초 생성 경합 방어 포함)
  return withLock(`e2ee:${root}`, async () => {
    const disk = readState(root); // 락 후 재독 — 캐시가 아니라 디스크가 병합 기준
    const next = { ...disk, dek: Buffer.from(buf).toString('base64') };
    const tmp = await writeTmp(next, root);
    await rename(tmp, fileOf(root)); // 갱신은 원자 교체(존재하는 파일의 업데이트라 create-exclusive 아님)
    cache = { root, state: next };
    dekBuf = Buffer.from(buf);
  });
}

export function clearDekCache() { cache = null; dekBuf = null; }

/* ── DEK 랩 — 임시-정적 X25519 ECDH + AES-256-GCM. 서버는 이 blob을 내용 못 보는 우편함으로만 나른다. ──
   형식: MAGICW(15) ∥ ephPub(32) ∥ IV(12) ∥ TAG(16) ∥ CT. HKDF info에 양쪽 공개키를 각인해
   바꿔치기(서버가 다른 수신자 랩을 붙여주는 류)를 키 수준에서 무효화한다. */
const MAGICW = Buffer.from('argokeywrap.v1:');
const IV_LEN = 12;
const TAG_LEN = 16;
const wrapKey = (shared, ephPubRaw, recipientPubRaw) =>
  Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephPubRaw, recipientPubRaw]), 'argo-e2ee-keywrap-v1', 32));

/** recipientPubB64(기기 공개키 raw base64) 앞으로 DEK를 랩. */
export function wrapDekFor(recipientPubB64, dekBytes) {
  const recipientRaw = Buffer.from(recipientPubB64, 'base64');
  if (recipientRaw.length !== 32) throw new Error('수신 공개키 형식 오류(raw 32B 아님)');
  const eph = generateKeyPairSync('x25519');
  const ephPubRaw = publicKeyToRaw(eph.publicKey);
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: rawToPublicKey(recipientRaw) });
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', wrapKey(shared, ephPubRaw, recipientRaw), iv);
  const ct = Buffer.concat([c.update(dekBytes), c.final()]);
  return Buffer.concat([MAGICW, ephPubRaw, iv, c.getAuthTag(), ct]);
}

/** 내 기기 개인키로 DEK 랩 개봉. 위변조·수신자 불일치는 GCM 태그가 거부한다(throw). */
export async function openDekWrap(blob, { root = WS_ROOT } = {}) {
  if (!blob.subarray(0, MAGICW.length).equals(MAGICW)) throw new Error('DEK 랩 형식 아님');
  const state = await loadDeviceE2ee({ root });
  const myPriv = rawToPrivateKey(Buffer.from(state.priv, 'base64'));
  const myPubRaw = Buffer.from(state.pub, 'base64');
  let off = MAGICW.length;
  const ephPubRaw = blob.subarray(off, off += 32);
  const iv = blob.subarray(off, off += IV_LEN);
  const tag = blob.subarray(off, off += TAG_LEN);
  const ct = blob.subarray(off);
  const shared = diffieHellman({ privateKey: myPriv, publicKey: rawToPublicKey(ephPubRaw) });
  const d = createDecipheriv('aes-256-gcm', wrapKey(shared, ephPubRaw, myPubRaw), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/* ── 기기 공개키 등록 — device_keys upsert(own-only RLS). 실패는 기능을 막지 않는다(단계 0은
   등록부 구축이 전부) — 프로세스·오너당 1회만 시도하고, 테이블 부재(셀프호스트 등)는 1회 경고 후 침묵. ── */
const registered = new Set(); // `${ownerId}` — 프로세스 수명 가드
export async function ensureDeviceKeyRegistered(sb, ownerId, deviceId, { root = WS_ROOT } = {}) {
  if (!sb || !ownerId || !deviceId || registered.has(ownerId)) return;
  registered.add(ownerId); // 실패해도 재시도 안 함 — 등록은 다음 프로세스 기동이 자연 재시도
  try {
    const state = await loadDeviceE2ee({ root });
    // ignoreDuplicates — **pubkey는 최초 등록 후 불변**(E2EE-DESIGN.md §10.5): device_id는 자기신고
    // 값이라 갱신을 허용하면 탈취 세션 하나로 기존 기기의 pubkey를 바꿔치기(하이재킹)할 수 있다.
    // 키 파일을 잃은 기기의 재등록은 revoke(행 삭제) 후 신규 등록 경로로만.
    const { error } = await sb.from('device_keys').upsert(
      { user_id: ownerId, device_id: deviceId, pubkey: state.pub },
      { onConflict: 'user_id,device_id', ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[argo] e2ee 기기 공개키 등록 보류(기능 무영향):', String(e.message).slice(0, 80));
  }
}
export function _resetRegisteredForTest() { registered.clear(); }

/* ── P1: 대조 지문·복구 코드·자기 랩 회수 ── */

/** 공개키 지문 — 기기 승인 화면의 대조 코드(SAS). 새 기기와 승인 기기 양쪽이 같은 값을 계산해
    표시하므로, 서버가 공개키를 바꿔치면 두 화면의 숫자가 어긋나 사용자 대조가 실패한다.
    (HKDF 각인이 막는 "랩 재해석"과는 별개의 방어선 — E2EE-DESIGN.md §10.5) */
export const pubFingerprint = (pubB64) =>
  createHash('sha256').update(Buffer.from(pubB64, 'base64')).digest('hex').slice(0, 6).toUpperCase();

/** 복구 코드 — 160bit 랜덤을 Crockford base32(8자×4묶음)로. 생성 시 1회만 표시하고 저장하지 않는다. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function generateRecoveryCode() {
  const bytes = randomBytes(20); // 160bit
  let bits = 0, acc = 0, out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCKFORD[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.slice(0, 32).match(/.{1,8}/g).join('-'); // XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
}

/** 복구 코드 정규화 — 사용자 입력 관용(소문자·구분자·Crockford 동형문자 O→0, I/L→1). */
export const normalizeRecoveryCode = (s) =>
  String(s).toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

/** 복구 KEK 유도 — scrypt(Node 내장, 의존성 무추가). 코드가 160bit 랜덤이라 사전 공격이 무의미하고
    KDF는 방어 심층이다(E2EE-DESIGN.md §4). 파라미터는 recovery_wraps.kdf에 기록돼 미래 상향과 공존. */
export const RECOVERY_KDF = { alg: 'scrypt', N: 131072, r: 8, p: 1 };
export function deriveRecoveryKek(code, saltB64, kdf = RECOVERY_KDF) {
  if (kdf.alg !== 'scrypt') throw new Error(`알 수 없는 복구 KDF: ${kdf.alg} — 앱 업데이트가 필요합니다`);
  return scryptSync(normalizeRecoveryCode(code), Buffer.from(saltB64, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

/* 복구 랩 — 대칭 KEK로 DEK를 직접 봉인(기기 랩의 ECDH와 달리 수신 공개키가 없다). */
const MAGICR = Buffer.from('argorecwrap.v1:');
export function wrapDekWithKek(kek, dekBytes) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dekBytes), c.final()]);
  return Buffer.concat([MAGICR, iv, c.getAuthTag(), ct]);
}
export function openDekWithKek(kek, blob) {
  if (!blob.subarray(0, MAGICR.length).equals(MAGICR)) throw new Error('복구 랩 형식 아님');
  let off = MAGICR.length;
  const iv = blob.subarray(off, off += IV_LEN);
  const tag = blob.subarray(off, off += TAG_LEN);
  const ct = blob.subarray(off);
  const d = createDecipheriv('aes-256-gcm', kek, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(ct), d.final()]); }
  catch { throw new Error('복구 코드가 맞지 않습니다'); } // GCM 태그 불일치 = 코드 오입력(정직 문구)
}

/** 자기 랩 회수(claim) — wrapped_deks에서 내 기기 행을 찾아 DEK를 개봉·보관한다.
    승인(다른 기기가 내 공개키로 랩을 넣어줌) 후 이 기기가 잠김을 푸는 경로. cycle이 DEK 미보유일 때
    60초 간격으로 시도한다(가벼운 own-RLS select 1행). 반환: true = DEK 확보. */
let lastClaim = 0;
export async function tryClaimDek(sb, deviceId, { root = WS_ROOT, force = false } = {}) {
  if (dekBuf) return true;
  if (!sb || !deviceId) return false;
  if (!force && Date.now() - lastClaim < 60_000) return false;
  lastClaim = Date.now();
  try {
    const { data, error } = await sb.from('wrapped_deks').select('wrap').eq('device_id', deviceId).maybeSingle();
    if (error || !data?.wrap) return false;
    const dekBytes = await openDekWrap(Buffer.from(data.wrap, 'base64'), { root });
    await setDek(dekBytes, { root });
    console.log('[argo] e2ee: 이 기기의 열쇠(DEK) 수신 — 잠김 해제');
    return true;
  } catch (e) {
    console.warn('[argo] e2ee: 열쇠 회수 보류:', String(e.message).slice(0, 80));
    return false;
  }
}
export function _resetClaimForTest() { lastClaim = 0; }
