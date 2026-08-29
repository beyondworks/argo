// E2EE 단계 0 — 기기 키쌍(X25519)·계정 DEK 로컬 보관·DEK 랩/언랩·기기 공개키 등록.
// 설계 정본: 루트 E2EE-DESIGN.md(§4~§7). 원칙: 서버에는 공개키와 암호문(랩)만 — 평문 열쇠는
// 어떤 형태로도 서버에 두지 않는다(account_keys 평문 구조와의 근본 차이).
//
// 파일: WS_ROOT/.device-e2ee.json (0600) — 회사 폴더 밖이라 동기화 엔진이 걷지 않는다
// (.device-session.json과 동일 원칙: 기기 로컬 상태). { pub, priv, dek? } 전부 base64.
// dek는 이 계정의 데이터 키 — 켜는 기기가 생성하거나(P1), 기기 승인으로 수신하면 여기 저장된다.
// 단계 0에서는 keypair 생성·등록까지만 실사용되고 dek는 비어 있다(동작 불변).
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function persist(state, root) {
  await mkdir(root, { recursive: true });
  // 생성 시점부터 0600 + rename 교체 — 개인키·DEK가 기본 모드로 노출되는 창을 없앤다(synccreds와 동일)
  const tmp = join(root, `.tmp-e2ee-${process.pid}-${Date.now().toString(36)}`);
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(tmp, fileOf(root));
}

/** 기기 E2EE 상태 로드 — 없으면 X25519 키쌍을 만들어 저장(최초 1회). 손상 시 재생성하지 않고 throw —
    조용한 키 교체는 기존 랩(wrapped_deks)을 전부 못 열게 만든다(정직 실패가 안전 방향). */
export async function loadDeviceE2ee({ root = WS_ROOT } = {}) {
  if (cache && cache.root === root) return cache.state;
  let state = null;
  let raw = null;
  try { raw = readFileSync(fileOf(root), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (raw != null) {
    const d = JSON.parse(raw); // 손상 = throw(위 주석 — 키 유실을 조용히 덮지 않는다)
    if (!d.pub || !d.priv) throw new Error('기기 E2EE 키 파일 손상 — pub/priv 누락');
    state = d;
  } else {
    const { publicKey, privateKey } = generateKeyPairSync('x25519');
    state = { v: 1, pub: publicKeyToRaw(publicKey).toString('base64'), priv: privateKeyToRaw(privateKey).toString('base64') };
    await persist(state, root);
  }
  cache = { root, state };
  dekBuf = state.dek ? Buffer.from(state.dek, 'base64') : null;
  return state;
}

/** 동기 DEK 접근 — secretbox 전용(accountKey와 동일 계약). 미보유면 null. */
export const dek = () => dekBuf;

/** DEK 수신·보관(P1: 켜기·기기 승인·복구 코드 경로가 호출). 디스크와 캐시를 함께 갱신. */
export async function setDek(buf, { root = WS_ROOT } = {}) {
  const state = await loadDeviceE2ee({ root });
  const next = { ...state, dek: Buffer.from(buf).toString('base64') };
  await persist(next, root);
  cache = { root, state: next };
  dekBuf = Buffer.from(buf);
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
    const { error } = await sb.from('device_keys').upsert(
      { user_id: ownerId, device_id: deviceId, pubkey: state.pub },
      { onConflict: 'user_id,device_id' },
    );
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[argo] e2ee 기기 공개키 등록 보류(기능 무영향):', String(e.message).slice(0, 80));
  }
}
export function _resetRegisteredForTest() { registered.clear(); }
