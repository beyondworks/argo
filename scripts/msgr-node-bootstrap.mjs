#!/usr/bin/env node
// 상주 노드 부트스트랩 CLI — 노드에서 한 번 실행한다. 값은 env로만 받는다(인자·출력에 비밀 없음).
//   ARGO_NODE_CODE=<조직 카드의 연결 코드> ARGO_NODE_EMAIL=<서비스 계정> ARGO_NODE_PASSWORD=<비밀번호> ARGO_ROOT=/data node scripts/msgr-node-bootstrap.mjs
// Supabase 공개 설정은 NEXT_PUBLIC_SUPABASE_URL·NEXT_PUBLIC_SUPABASE_ANON_KEY(워커 이미지에 이미 있음; 개발은 VITE_* 도 허용).
const env = process.env;
const url = env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL, anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
const { bootstrapNode } = await import('../src/msgr-node.mjs');
try {
  const r = await bootstrapNode({ code: env.ARGO_NODE_CODE, url, anonKey, email: env.ARGO_NODE_EMAIL, password: env.ARGO_NODE_PASSWORD, lang: env.ARGO_LANG === 'en' ? 'en' : 'ko' });
  console.log(`[node] 연결됨 — 조직 "${r.orgName}"(${r.orgId}) · 회사 ${r.ws} · 서비스 계정 ${r.uid}`);
  console.log(`[node] 워커로 띄울 때 ARGO_TENANT_OWNER=${r.uid} 로 고정하세요(이 계정 외 요청 거부 + 크루 등록이 resident로 판정).`);
} catch (e) {
  const m = String(e.message ?? e);
  const hint = /msgr_node_not_admin/.test(m) ? '소유자·관리자 계정은 노드가 될 수 없습니다 — 노드 전용 계정으로 실행하세요.'
    : /msgr_seat_limit/.test(m) ? '조직 좌석이 찼습니다 — 관리자가 좌석을 늘리거나 멤버를 정리한 뒤 다시 실행하세요.'
    : /msgr_invite_invalid/.test(m) ? '연결 코드가 없거나 만료·사용됐습니다 — 조직 카드에서 코드를 다시 만드세요(코드는 한 번만 쓸 수 있습니다).'
    : null;
  console.error('[node] 실패:', hint ?? m);
  process.exit(1);
}
