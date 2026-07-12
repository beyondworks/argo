// 페어링 브리지 — 앱이 코드 발급(POST) / 폴링 회수(GET). bind는 별도 라우트(브라우저용).
import { createPairing, claimPairing } from './store.mjs';

// 앱: 새 페어링 코드 발급
export async function POST(req) {
  const { code } = await req.json().catch(() => ({}));
  if (!code || typeof code !== 'string' || code.length < 16) {
    return Response.json({ error: '유효한 코드가 필요합니다' }, { status: 400 });
  }
  createPairing(code);
  return Response.json({ ok: true });
}

// 앱: 폴링 — 브라우저 로그인이 끝나면 세션을 1회 돌려준다
export async function GET(req) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) return Response.json({ status: 'expired' });
  return Response.json(claimPairing(code));
}
