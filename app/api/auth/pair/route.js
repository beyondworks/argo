// 페어링 브리지 — 앱이 코드 발급(POST) / 폴링 회수(GET). bind는 별도 라우트(브라우저용).
// 보안: 코드는 서버가 생성한다(클라이언트가 임의 코드를 등록하지 못하게). verifier는 앱만 알고,
//   authorize redirect엔 code만 싣는다 → 코드만 노출된 피싱 링크로는 세션을 회수할 수 없다.
import { createPairing, claimPairing } from './store.mjs';

// 고엔트로피 랜덤 hex — Web Crypto(전역)로 edge/node 모두에서 동작
const rand = () => {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
};

// 앱: 서버가 새 페어링 코드+verifier를 생성해 반환
export async function POST() {
  const code = rand();
  const verifier = rand();
  createPairing(code, verifier);
  return Response.json({ code, verifier });
}

// 앱: 폴링 — code+verifier가 일치하고 브라우저 로그인이 끝나면 세션을 1회 돌려준다
export async function GET(req) {
  const q = new URL(req.url).searchParams;
  const code = q.get('code');
  const verifier = q.get('verifier');
  if (!code || !verifier) return Response.json({ status: 'expired' });
  return Response.json(claimPairing(code, verifier));
}
