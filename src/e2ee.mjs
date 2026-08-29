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
