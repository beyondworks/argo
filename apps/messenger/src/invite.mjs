// 초대 코드 공유·파싱(순수) — 데스크톱 앱에서는 location.origin이 tauri://localhost라 "링크"가 받는 사람에게 열리지 않는다
// (실측 2026-09-08: 설치 앱에서 되는 초대가 회사 이메일 자동 가입뿐이었다). 그래서 공유물은 **코드가 담긴 안내문**이고,
// 받는 사람은 앱의 "초대 코드로 가입"에 안내문·링크·코드 중 무엇을 붙여 넣어도 된다. 코드 = 서버 기본값 24B hex(48자).
export const INVITE_CODE_RE = /[0-9a-f]{48}/i;

/** 붙여 넣은 문자열에서 초대 코드를 뽑는다 — `?invite=<code>` 링크·안내문·맨 코드 전부. 없으면 null. */
export function parseInviteCode(s) {
  const m = String(s ?? '').match(/invite=([0-9a-f]{48})/i) ?? String(s ?? '').match(INVITE_CODE_RE);
  return m ? m[1] ?? m[0] : null;
}

/** 공유 안내문 — 브라우저 세션(http 오리진)에서만 링크를 덧붙인다(앱의 tauri://·file: 오리진은 뺀다). */
export function inviteShareText(code, { origin = '', pathname = '/', t = (k, v) => `${k} ${JSON.stringify(v)}` } = {}) {
  const link = /^https?:\/\//.test(origin) ? `${origin}${pathname}?invite=${code}` : '';
  return t('org.invite.text', { code }) + (link ? `\n${link}` : '');
}
