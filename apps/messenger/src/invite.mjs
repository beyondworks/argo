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
// 3줄 평문(유건 2026-09-18): 누가 어디로 초대했나 / 링크(브라우저) 또는 코드 한 줄 / 어디에 붙여 넣나 · 며칠 안에.
// 마크다운 기호·곁가지 안내 없음. 메뉴 이름은 화면 문구(org.join.code)를 그대로 끼워 넣어 어긋나지 않게 한다.
export function inviteShareText(code, { origin = '', pathname = '/', t = (k, v) => `${k} ${JSON.stringify(v)}`, inviter = '', org = '', channels = [], days = null } = {}) {
  const head = !channels.length ? t('inv.share.headOrg', { name: inviter, org })
    : channels.length === 1 ? t('inv.share.head', { name: inviter, org, channel: channels[0] })
    : t('inv.share.headMore', { name: inviter, org, channel: channels[0], n: channels.length - 1 });
  const how = t('inv.share.how', { join: t('org.join.code') }) + (days > 0 ? t('inv.share.days', { n: days }) : '');
  return [head, inviteLink(code, { origin, pathname }) ?? code, how].join('\n');
}
/** 브라우저(http) 오리진에서만 여는 링크, 앱(tauri://·file:) 오리진이면 null — 초대 창의 링크 칸은 null이면 코드를 보여 준다. */
export const inviteLink = (code, { origin = '', pathname = '/' } = {}) => /^https?:\/\//.test(origin) ? `${origin}${pathname}?invite=${code}` : null;

/** 친구 링크 공유 문구 — 조직 초대와 섞이지 않게 말부터 다르다("조직에 초대"가 아니라 "친구 추가"다). */
export function friendShareText(code, { t = (k, v) => `${k} ${JSON.stringify(v)}` } = {}) {
  return t('friends.link.text', { code });
}
