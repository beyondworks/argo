// M-1 기기 페어링 — 연결 코드 하나로 두 번째 기기가 동기화 자격(Supabase URL·서비스 키·오너)을 받는다.
// 코드는 자가완결(서버 우편함 없음): 사용자가 복사→붙여넣기로 직접 운반한다. 비밀번호처럼 다뤄야 함.
// M-2(테넌트 스코프 자격)에서 payload만 교체할 수 있도록 버전 접두사로 봉인.
const PREFIX = 'argo-pair.v1.';

/** 동기화 자격 → 연결 코드. */
export function makePairCode({ url, key, owner }) {
  if (!url || !key || !owner) throw new Error('페어링에 필요한 값 누락 (url/key/owner)');
  return PREFIX + Buffer.from(JSON.stringify({ u: url, k: key, o: owner })).toString('base64url');
}

/** 연결 코드 → 동기화 자격. 형식 불일치·필드 누락은 throw — 조용히 빈 자격을 만들지 않는다. */
export function parsePairCode(code) {
  const s = String(code ?? '').trim();
  if (!s.startsWith(PREFIX)) throw new Error('연결 코드 형식이 아닙니다');
  let obj;
  try { obj = JSON.parse(Buffer.from(s.slice(PREFIX.length), 'base64url').toString('utf8')); }
  catch { throw new Error('연결 코드를 해독할 수 없습니다'); }
  const { u, k, o } = obj ?? {};
  if (!u || !k || !o) throw new Error('연결 코드에 필요한 값이 없습니다');
  return { url: u, key: k, owner: o };
}
