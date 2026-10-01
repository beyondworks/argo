// 기억 탭 활동 기록의 문장 — 서버가 남기는 동작 코드(action)를 사람이 읽는 한 문장으로. 순수 함수(App.jsx Activity가 쓴다).
// 사전에 없는 동작은 코드를 보이지 않고 일반 문구로(act.fallback). 이름은 호출한 쪽이 준 규칙(nameOfUser)을 쓴다 — id 앞 8자리가 보이지 않게.

/** 한국어 조사 — 사전 문장의 "이(가)·을(를)·(으)로·은(는)"을 앞말 받침에 맞춰 고른다(영문·숫자 끝은 받침 없음으로). */
export const koJosa = (txt) => txt.replace(/(\S)(이\(가\)|을\(를\)|\(으\)로|은\(는\))/g, (all, ch, j) => {
  const code = ch.charCodeAt(0); const hangul = code >= 0xac00 && code <= 0xd7a3; const jong = hangul ? (code - 0xac00) % 28 : 0;
  const pick = { '이(가)': jong ? '이' : '가', '을(를)': jong ? '을' : '를', '(으)로': (jong && jong !== 8) ? '으로' : '로', '은(는)': jong ? '은' : '는' }[j];
  return ch + pick;
});

/** 사전 키 고르기 — 같은 동작이어도 내용에 따라 문장이 갈리는 경우(빈 괄호·빈 칸이 생기지 않게). */
function keyOf(a, m, p) {
  if (a === 'channel.admins' && !p.admins) return 'act.channel.admins.none';
  if (m.cascade === 'account_delete' && (a === 'org.service_account' || a === 'org.successor')) return `act.${a}.cleared`; // 계정 삭제 캐스케이드 해제는 전용 문구(빈 {to}·탈퇴자 uuid 대신, 검수 #529 3R)
  if (a === 'org.domain' && !p.domain) return 'act.org.domain.off'; // 도메인이 비면 "끔" — 빈 괄호를 남기지 않는다
  if (a === 'member.offboard' && !(p.n > 0)) return 'act.member.offboard.none';
  if (a === 'member.join.domain' && !p.domain) return 'act.member.join.domain.none';
  return `act.${a}`;
}

export function activitySentence({ r, t, lang, nameOfUser, chName, crewName, docTitle, roleName }) {
  const m = r.meta ?? {}; const a = r.action;
  const who = r.actor_user_id ? nameOfUser(r.actor_user_id) : r.actor_crew_id ? crewName(r.actor_crew_id) : t('act.system');
  const p = { who, target: r.target_kind === 'user' ? nameOfUser(r.target_id) : r.target_kind === 'channel' ? `#${chName(r.target_id)}` : r.target_kind === 'crew' ? crewName(r.target_id) : r.target_kind === 'doc' ? (docTitle(r.target_id) ?? m.path ?? '') : '',
    from: m.from ? (a === 'member.role' || a === 'channel.personal_crews' ? (a === 'member.role' ? roleName(m.from) : t(`ch.personal.${m.from}`)) : nameOfUser(m.from)) : '', to: m.to ? (a === 'member.role' ? roleName(m.to) : a === 'channel.personal_crews' ? t(`ch.personal.${m.to}`) : nameOfUser(m.to)) : '',
    role: roleName(m.role), channel: m.channel || m.channel_id ? `#${chName(m.channel ?? m.channel_id)}` : '', name: m.name ?? '', domain: m.domain ?? '', path: m.path ?? '', n: m.crews_detached ?? 0, days: m.guest_days ?? '', admins: Array.isArray(m.admins) ? m.admins.map(nameOfUser).join(', ') : '',
    roleText: m.role_text ?? '', extendDays: m.days ?? '' };
  p.detail = (p.role || p.channel) ? ` (${p.role}${p.channel})` : ''; // 초대 수락: 역할·채널이 둘 다 없으면 빈 괄호를 남기지 않는다
  const key = keyOf(a, m, p);
  const txt = t(key, p);
  const out = txt === key ? t('act.fallback', { who }) : txt; // 사전에 없는 코드는 코드 대신 일반 문구
  return lang === 'en' ? out : koJosa(out);
}
