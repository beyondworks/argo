// 시크릿 봉투 암호화 — 동기화로 흐르는 크레덴셜(봇 토큰·러너 키)은 스토리지에 항상 암호문으로만.
// v2(현행): 계정 키(account_keys, 본인 행만 RLS)에서 HKDF 파생 — 로그인-연동 기기도 열 수 있다.
// v1(레거시, 열기 전용): 서비스 키 HKDF — 기존 클라우드 암호문 호환. 크레덴셜이 변경되면 v2로 재봉인된다.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { loadSyncCreds } from './synccreds.mjs';
import { accountKey } from './accountkey.mjs';
import { dek } from './e2ee.mjs';

const MAGIC3 = Buffer.from('argosecret.v3:'); // E2EE — 키가 사용자 기기에만(DEK). 서버는 절대 못 연다.
const MAGIC2 = Buffer.from('argosecret.v2:');
const MAGIC1 = Buffer.from('argosecret.v1:');
const GENERATION = Buffer.from('argosecret.'); // 세대 공통 접두 — 미지 세대의 평문 통과를 막는 전방 호환 게이트
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

// v3 키 — 계정 DEK(사용자 기기에만 존재)에서 파생. DEK 미보유 = 이 기기가 아직 승인 전이라는 뜻이고,
// 그때의 개봉 시도는 명확한 오류로 보류된다(per-file catch가 잡아 다음 사이클 재시도 — 불가시 홀드).
let k3 = null, k3src = null;
function key3() {
  const dk = dek();
  if (!dk) throw new Error('E2EE 봉투(v3) — 이 기기에 아직 열쇠가 없습니다(기기 승인·복구 대기)');
  if (!k3 || k3src !== dk) {
    k3 = Buffer.from(hkdfSync('sha256', dk, 'argo-e2ee-v3', 'secretbox', 32));
    k3src = dk;
  }
  return k3;
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

/** 이름으로 판정하는 자격 파일(순수) — 사용자가 vault·작업 폴더에 둔 .env·키·토큰 파일. 클라우드 감사(2026-09-05 실측): 회사 vault의
    `.env`·`credentials.json`·`token.json`·`*.pem`·k8s `secret.yaml`이 평문으로 올라가 있었다(vault 암호화는 옵트인이라 제어 파일 3종만 봉투였다).
    유건 지시 "환경변수는 Supabase에 평문으로 남으면 안 돼" → 이 이름들은 제어 파일과 같은 계급(봉투, 키 없으면 미업로드).
    예시 파일(.env.example/.sample/.template/.dist)은 비밀이 아니라 제외. 공개 CA 번들(cacert.pem·roots.pem)은 봉인해도 무해라 굳이 안 가른다. */
export const SECRET_NAME_RE = /^(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|kubeconfig|auth\.json|credentials(\.json)?|\.credentials\.json|tokens?\.json|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|[^/]*\.(pem|key|p12|pfx|jks|keystore)|service[-_]?account[^/]*\.json|secrets?(\.[^/]+)?\.(json|ya?ml|env)|settings\.local\.json)$/i;
export const SECRET_DIR_RE = /(^|\/)\.(aws|ssh|gnupg|codex|config\/gh|azure|kube)\//;
export const isSecretNameRel = (rel) => { const r = String(rel ?? ''); const base = r.split('/').pop() ?? '';
  if (/\.(example|sample|template|dist)$/i.test(base)) return false; // .env.local.example 같은 예시 파일은 비밀이 아니다
  return SECRET_NAME_RE.test(base) || SECRET_DIR_RE.test(r); };

/** 회수·불가시 계급 — 회사 폴더의 크레덴셜 저장소 3종**만**. 호스티드 credSync-off 회수 루프(sync.mjs noSecrets)·마커 판정·엄격 개봉이 이 계급을 쓴다.
    mcp.json 포함: 호스트 MCP 가져오기가 env(토큰)를 담으므로 클라우드에는 항상 암호문으로.
    ⚠ 이름 규칙(isSecretNameRel)을 여기에 합치지 않는다 — 합치면 호스티드 동기화가 사용자 문서(.key 키노트·.pem 번들·auth.json…)의
    클라우드 사본을 26바이트 마커로 덮어 비가역 유실시킨다(분리 검수 CRITICAL-1, 격리 저장소 실측). 이름 규칙은 봉인 계급(isEncRel)에만 태운다. */
export const isSecretRel = (rel) => rel === 'connections.json' || rel === '.secrets.json' || rel === 'mcp.json';

/** credSync off 회수 마커 — 클라우드의 자격 암호문을 "삭제" 대신 이 내용으로 덮어쓴다(upsert).
    blob을 지우면 아직 토글을 못 받은 기기(구버전 포함)가 "원격 부재 + base 무변경 = 삭제"로 오판해
    **자기 로컬 자격을 지운다**(sync.mjs `l && !r` 분기). blob이 살아 있으면 그 기기들은 자기치유(heal)
    분기를 타 로컬을 보존한다 — blobExists는 내용이 아니라 실존만 본다.
    값이 **무효 봉투**(MAGIC 접두 + 형식 불일치)인 이유(분리 검수 MEDIUM-1, 구버전 실코드 재현):
    평문 JSON 마커는 구버전의 mcp.json 관용 개봉(passthrough)이 설정 파일로 받아 적고, 다음 사이클에
    봉투로 재봉인해 클라우드 정본으로 만들었다(전파형 설정 파괴). MAGIC으로 시작하면 구버전
    openSecretCompat이 openSecret으로 보내 throw → 아무것도 안 쓰고 보류한다(유실 없음).
    새 코드는 개봉 전에 isCredWithdrawn 바이트 비교로 먼저 걸러내므로 이 값에 무영향이다. */
export const CRED_WITHDRAWN = Buffer.from('argosecret.v2:credSync-off');
export const isCredWithdrawn = (buf) => buf.length === CRED_WITHDRAWN.length && buf.equals(CRED_WITHDRAWN);

/** M-ENC-1 롤아웃 스위치 — 켜면 동기되는 회사 폴더 전체(기억·대화·크루·스킬·원장)를 봉투 암호화한다.
    off(기본)면 기존과 동일(크레덴셜 3종만) = 동작 불변.
    ⚠ 2단계 롤아웃 강제: "봉투를 읽을 수 있는" 버전이 전 기기에 배포된 뒤에만 켠다.
    구버전은 암호문을 평문으로 오인해 로컬에 기록 → 그 기기의 기억이 손상된다. */
/** 회사 데이터 전체 봉투(v2·계정 키) 스위치 — 기본 켜짐(2026-09-06 유건 승인: 자료가 Supabase에 평문으로 남지 않게).
    끄기는 명시 옵트아웃(0·false·off·none)만. 켜져 있어도 읽기는 관용 개봉이라 구 클라이언트·기존 평문과 공존하고,
    계정 키 미확보 사이클은 EXCLUDE가 전체를 불가시로 보류한다(삭제 오판 없음 — sync.mjs isRealDelete). 사용자 절차는 불변(기기 승인 없음). */
export const encVaultOn = (env = process.env) => !['0', 'false', 'off', 'none'].includes(String(env.ARGO_ENC_VAULT ?? '').trim().toLowerCase());

/** 봉투 암호화 대상 — 크레덴셜은 항상, 그 외 동기 대상은 스위치가 켜졌을 때.
    읽기(개봉)는 이 예측자와 무관하게 항상 관용 개봉이라, 다른 기기가 먼저 켜도 안전하다(sync.mjs pullBuf). */
export const isEncRel = (rel) => isSecretRel(rel) || isSecretNameRel(rel) || encVaultOn(); // 봉인 계급: 제어 3종 + 자격 파일명 + (스위치) 전체

/** 봉투/레거시 평문 겸용 개봉 — 봉투 도입 전에 클라우드에 올라간 평문(mcp.json 등)을 수용한다.
    평문이면 그대로 반환하고, 다음 로컬 변경 push에서 봉투로 승격된다.
    ⚠ 전방 호환 게이트(E2EE 단계 0): 'argosecret.' 접두는 **세대 불문** 개봉기로 보낸다 — 정확 매칭만
    걸면 미래 세대(v3, v4…)가 평문으로 통과해 로컬 파일이 암호문으로 오염·재봉인·전파된다
    (credSync 마커 사고와 동일 계열을 세대 축에서 원천 차단). 모르는 세대는 개봉기가 throw로 보류한다. */
export function openSecretCompat(buf) {
  return buf.subarray(0, GENERATION.length).equals(GENERATION) ? openSecret(buf) : buf;
}

/** 이 버퍼가 봉투 세대('argosecret.' 접두)인가 — 열 수 있는지와 무관한 형식 판정.
    sync의 매니페스트 세대 다운그레이드 게이트가 쓴다(열지 못한 세대를 만난 기기가 평문을 되쓰지 않게). */
export const isEnvelopeGeneration = (buf) => buf.subarray(0, GENERATION.length).equals(GENERATION);

/** 평문 → v2 봉투(MAGIC ∥ iv ∥ tag ∥ ct). */
export function sealSecret(buf) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key2(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC2, iv, c.getAuthTag(), ct]);
}

/** v3(E2EE) 봉인 — 키는 사용자 기기의 DEK에서만 파생. 단계 1(옵트인)부터 쓰기 경로가 호출한다. */
export function sealSecretV3(buf) {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key3(), iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC3, iv, c.getAuthTag(), ct]);
}

/** 봉투 → 평문 (v3/v2/v1 디스패치). 위변조·형식 불일치는 throw — 조용히 깨진 평문을 쓰지 않는다.
    미지 세대('argosecret.' 접두인데 아는 MAGIC이 아님)도 throw — 구버전이 신세대 암호문을 다루게 될 때
    평문 오인이 아니라 보류가 되도록(per-file catch가 잡아 다음 사이클 재시도, 앱 업데이트가 해소). */
export function openSecret(buf) {
  const k = buf.subarray(0, MAGIC3.length).equals(MAGIC3) ? key3()
    : buf.subarray(0, MAGIC2.length).equals(MAGIC2) ? key2()
    : buf.subarray(0, MAGIC1.length).equals(MAGIC1) ? key1()
    : null;
  if (!k) {
    throw new Error(buf.subarray(0, GENERATION.length).equals(GENERATION)
      ? '미지 봉투 세대 — 이 파일을 읽으려면 앱 업데이트가 필요합니다(보류)'
      : '시크릿 봉투 형식 아님');
  }
  const off = MAGIC2.length; // v1/v2/v3 MAGIC 길이 동일(14)
  const iv = buf.subarray(off, off + IV_LEN);
  const tag = buf.subarray(off + IV_LEN, off + IV_LEN + TAG_LEN);
  const ct = buf.subarray(off + IV_LEN + TAG_LEN);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
