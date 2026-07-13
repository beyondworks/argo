// 인증 계층 — env가 있으면 켜지고, 없으면 로컬 1인 모드 그대로(회귀 0)라는 게이트가 원칙.
// 코어(src/*.mjs)는 인증을 모른다 — 요청 문맥(쿠키)이 필요한 이 계층은 라우트/미들웨어에서만 임포트한다.
// env: NEXT_PUBLIC_SUPABASE_URL · NEXT_PUBLIC_SUPABASE_ANON_KEY (.env.local 또는 배포 env — 값 평문 기록 금지)
import { readFile, writeFile } from 'node:fs/promises';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { paths } from '../src/workspace.mjs';

export const AUTH_ON = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

// 테넌트 바인딩 — 클라우드 워커는 인스턴스 1대 = 계정 1개(microVM 격리 설계).
// ARGO_TENANT_OWNER(Supabase user id)가 설정되면 그 계정 외 요청을 전부 거부한다.
// 로컬/공용 모드(미설정)는 무영향. 인증 off면 의미 없으므로 함께 무시한다.
const TENANT = process.env.ARGO_TENANT_OWNER?.trim() || null;
export function tenantDenied(user) {
  if (!TENANT || !AUTH_ON || !user) return null;
  if (user.id !== TENANT) {
    return Response.json({ error: '이 서버는 다른 계정 전용입니다' }, { status: 403 });
  }
  return null;
}

/** 현재 로그인 사용자. 인증 off = 로컬 1인 모드('local'). 인증 on + 미로그인 = null. */
export async function currentUser() {
  if (!AUTH_ON) return { id: 'local', email: '' };
  const store = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 — 미들웨어 담당 */ } } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  return user ? { id: user.id, email: user.email ?? '' } : null;
}

/** 회사 소유권 가드 — 위반 시 Response를 돌려준다(핸들러가 그대로 return). 통과 시 null.
    레거시 회사(ownerId 없음 — 로컬 시절 생성)는 아무에게나 귀속되지 않는다. 로컬→클라우드 이행을 위해
    ARGO_ADOPT_OWNER(이메일)와 현재 사용자 이메일이 일치할 때만 최초 소유자로 귀속한다 — 그 외엔 403. */
export async function guardCompany(wsId) {
  const user = await currentUser();
  if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
  if (!AUTH_ON) return null;
  const td = tenantDenied(user); if (td) return td; // 테넌트 바인딩 — 소유권 검사보다 먼저
  let meta;
  try {
    meta = JSON.parse(await readFile(paths(wsId).company, 'utf8'));
  } catch {
    return Response.json({ error: '회사를 찾을 수 없습니다' }, { status: 404 });
  }
  if (!meta.ownerId) {
    const adopt = process.env.ARGO_ADOPT_OWNER?.trim().toLowerCase();
    if (adopt && user.email && adopt === user.email.trim().toLowerCase()) {
      await writeFile(paths(wsId).company, JSON.stringify({ ...meta, ownerId: user.id }, null, 2));
      return null;
    }
    return Response.json({ error: '이 회사에 접근할 권한이 없습니다' }, { status: 403 });
  }
  if (meta.ownerId !== user.id) {
    return Response.json({ error: '이 회사에 접근할 권한이 없습니다' }, { status: 403 });
  }
  return null;
}
