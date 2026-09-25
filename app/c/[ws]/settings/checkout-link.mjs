// LS 체크아웃 링크 조립(순수). 실측 2026-09-25: checkout[email]이 빈 값·'undefined'면 LS가 422를 낸다(제보된 오류 화면).
// 결제 귀속은 custom user_id(src/lsbilling.mjs)라 이메일은 편의용 선기입일 뿐 — 올바를 때만 붙인다.
// 게스트(로컬 신원 'local')는 결제를 귀속할 계정이 없으니 링크를 만들지 않는다(null → 호출부가 로그인 안내).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkoutUrl(base, user) {
  if (!base || !user?.id || user.id === 'local') return null;
  const email = typeof user.email === 'string' ? user.email.trim() : '';
  const q = `checkout[custom][user_id]=${encodeURIComponent(user.id)}${EMAIL.test(email) ? `&checkout[email]=${encodeURIComponent(email)}` : ''}`;
  return `${base}${base.includes('?') ? '&' : '?'}${q}`;
}
