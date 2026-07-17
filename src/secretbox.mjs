// 시크릿 봉투 암호화 — 동기화로 흐르는 크레덴셜(봇 토큰·러너 키)은 스토리지에 항상 암호문으로만.
// v2(현행): 계정 키(account_keys, 본인 행만 RLS)에서 HKDF 파생 — 로그인-연동 기기도 열 수 있다.
// v1(레거시, 열기 전용): 서비스 키 HKDF — 기존 클라우드 암호문 호환. 크레덴셜이 변경되면 v2로 재봉인된다.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { loadSyncCreds } from './synccreds.mjs';
import { accountKey } from './accountkey.mjs';

const MAGIC2 = Buffer.from('argosecret.v2:');
const MAGIC1 = Buffer.from('argosecret.v1:');
const IV_LEN = 12;
const TAG_LEN = 16;

/** 봉투 가능 여부 = 계정 키 보유 (sync 사이클이 ensureAccountKey로 채운다). */
export const cryptoOn = () => !!accountKey();

// v2 키 — 계정 키에서 파생(도메인 분리). 계정 키 버퍼가 바뀌면 재파생.
let k2 = null, k2src = null;
function key2() {
  const ak = accountKey();
  if (!ak) throw new Error('시크릿 암호화 키 없음 (계정 키 미확보)');
  if (!k2 || k2src !== ak) {
    k2 = Buffer.from(hkdfSync('sha256', ak, 'argo-secret-sync-v2', 'secretbox', 32));
    k2src = ak;
  }
  return k2;
}

// v1 레거시 키 — 서비스 키 HKDF (열기 전용)
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY || loadSyncCreds()?.key || null;
let k1 = null, k1src = null;
function key1() {
  const sk = serviceKey();
  if (!sk) throw new Error('레거시 봉투(v1) — 서비스 키 없는 기기에서는 열 수 없습니다');
  if (!k1 || k1src !== sk) {
    k1 = Buffer.from(hkdfSync('sha256', sk, 'argo-secret-sync-v1', 'secretbox', 32));
    k1src = sk;
  }
  return k1;
}

/** 동기화에서 봉투 대상 파일 — 회사 폴더의 크레덴셜 저장소.
    mcp.json 포함: 호스트 MCP 가져오기가 env(토큰)를 담으므로 클라우드에는 항상 암호문으로. */
export const isSecretRel = (rel) => rel === 'connections.json' || rel === '.secrets.json' || rel === 'mcp.json';

/** 봉투/레거시 평문 겸용 개봉 — 봉투 도입 전에 클라우드에 올라간 평문(mcp.json 등)을 수용한다.
    평문이면 그대로 반환하고, 다음 로컬 변경 push에서 봉투로 승격된다. */
export function openSecretCompat(buf) {
  const enveloped = buf.subarray(0, MAGIC2.length).equals(MAGIC2) || buf.subarray(0, MAGIC1.length).equals(MAGIC1);
  return enveloped ? openSecret(buf) : buf;
}

/** 평문 → v2 봉투(MAGIC ∥ iv ∥ tag ∥ ct). */
export function sealSecret(buf) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key2(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC2, iv, c.getAuthTag(), ct]);
}

/** 봉투 → 평문 (v2/v1 디스패치). 위변조·형식 불일치는 throw — 조용히 깨진 평문을 쓰지 않는다. */
export function openSecret(buf) {
  const k = buf.subarray(0, MAGIC2.length).equals(MAGIC2) ? key2()
    : buf.subarray(0, MAGIC1.length).equals(MAGIC1) ? key1()
    : null;
  if (!k) throw new Error('시크릿 봉투 형식 아님');
  const off = MAGIC2.length; // v1/v2 MAGIC 길이 동일
  const iv = buf.subarray(off, off + IV_LEN);
  const tag = buf.subarray(off + IV_LEN, off + IV_LEN + TAG_LEN);
  const ct = buf.subarray(off + IV_LEN + TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
