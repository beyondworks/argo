// 시크릿 봉투 암호화 — 동기화로 흐르는 크레덴셜(봇 토큰·러너 키)은 스토리지에 항상 암호문으로만 놓인다.
// 키는 양쪽 기기(로컬 상주·클라우드 워커)가 이미 공유한 SUPABASE_SERVICE_ROLE_KEY에서 HKDF로 파생 —
// 새 비밀을 만들지 않으면서, 스토리지가 유출돼도 평문 크레덴셜은 노출되지 않는다.
// (패키징 앱 등 서비스 키 없는 환경은 CRYPTO_ON=false — 시크릿은 기존대로 동기화 제외, 기기별 입력)
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('argosecret.v1:');
const IV_LEN = 12;
const TAG_LEN = 16;

// 호출 시점 평가 — 테스트·런타임에서 env 주입 순서에 안전
export const cryptoOn = () => !!process.env.SUPABASE_SERVICE_ROLE_KEY;

let cachedKey = null;
function key() {
  if (!cryptoOn()) throw new Error('시크릿 암호화 키 없음 (SUPABASE_SERVICE_ROLE_KEY)');
  cachedKey ??= Buffer.from(hkdfSync(
    'sha256',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    'argo-secret-sync-v1', // salt — 용도 고정
    'secretbox',           // info
    32,
  ));
  return cachedKey;
}

/** 동기화에서 봉투 대상 파일 — 회사 폴더의 크레덴셜 저장소 2종. */
export const isSecretRel = (rel) => rel === 'connections.json' || rel === '.secrets.json';

/** 평문 → 봉투(MAGIC ∥ iv ∥ tag ∥ ct). */
export function sealSecret(buf) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

/** 봉투 → 평문. 위변조(tag 불일치)·봉투 아님은 throw — 조용히 깨진 평문을 쓰지 않는다. */
export function openSecret(buf) {
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('시크릿 봉투 형식 아님');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = buf.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
