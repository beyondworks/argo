import { AUTH_ON, currentUser } from '../../auth.mjs';

/** 현재 사용자 — 사이드바 사용자 표시·로그아웃 노출 판단의 원천. */
export async function GET() {
  const user = await currentUser();
  return Response.json({ authOn: AUTH_ON, user });
}
