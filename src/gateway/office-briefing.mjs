// 에이전트 브리핑 도구(office_briefing) — 유건 10/5 "브리핑은 필요해", "브리핑은 개인 공간에서 보이도록".
// 인트라넷 에이전트 도구 briefing_add·briefing_list를 아르고 오피스로 옮긴 것. 브리핑은 받는 사람의 오피스 '내 공간'에 모인다.
// 관문: 다른 오피스 도구와 같은 officeTurn(위임 턴 거절 → 메신저 대화 → 주인의 기기 세션 → 방 사람). 조직이 없는 개인 공간 대화도 받는다.
// · 쓰기·읽기 모두 주인 혼자 보는 1:1에서만. 이 도구는 주인 계정으로 쓰므로, 여럿이 있는 채널에서 받으면 다른 구성원이 주인(관리자)의 권한으로
//   조직 전체 브리핑을 돌리거나 주인 브리핑함에 글을 넣게 된다(보안 검토: 남의 부탁을 주인 권한으로 실행). 조직 안 1:1이면 그 조직이 정해진다.
// · 쓰기(brief_add): 받는 사람은 기본 주인 본인. recipient='org'면 조직 전체(주인이 그 조직 관리자일 때만 — 서버가 판정). 작성자 이름은 이 에이전트.
// 부하: 사람이 시킬 때만(폴링 없음). 호출당 rpc 1건(+ 방 사람 확인 1~2건).
import { randomUUID } from 'node:crypto';
import { officeTurn, ONLY_DM, refusalText } from './office-audience.mjs';

export const briefingDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  newId: () => randomUUID(),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const NAME = { ko: '브리핑 도구', en: 'briefing tool' };
export const BODY_CAP = 32768, LIST_CAP = 20;
const ERRORS = {
  briefing_forbidden: ['권한이 없다(남에게·조직 전체로 보내는 브리핑은 그 조직 관리자만)', 'not allowed (only organization admins send briefings to others or the whole organization)'],
  briefing_recipient: ['받는 사람이 그 조직 구성원이 아니다', 'the recipient is not a member of that organization'],
  briefing_limit: ['하루 상한에 걸렸다(받는 사람당 50건, 조직 전체 20건)', 'daily limit reached (50 per recipient, 20 organization-wide)'],
  briefing_input: ['입력이 올바르지 않다(제목 1~300자, 본문 32KB까지)', 'invalid input (title 1-300 chars, body up to 32KB)'],
  briefing_missing: ['없는 브리핑이다', 'no such briefing'],
};
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
  return data;
}

export async function briefingTool(args, { ctx = null, crew = null, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  const gate = await officeTurn({ ctx, ownerId, lang, session: briefingDeps.session, name: NAME, personal: true });
  if (gate.text) return gate.text;
  const { c, org, owner } = gate;
  if (!owner) return pick(`브리핑은 주인 개인 기록이라 ${ONLY_DM(lang)} 쓰고 읽는다 — 여럿이 보는 방에서는 다루지 않는다. 주인에게 1:1로 부탁해 달라고 알려라.`, `Briefings are the owner's personal records, so they are written and read ${ONLY_DM(lang)}. Ask the owner to request it in a 1:1.`, lang);
  try {
    if (a.action === 'brief_add') {
      const title = String(a.title ?? '').trim(), body = String(a.body ?? '');
      if (!title) return pick('brief_add에는 title이 필요하다.', 'brief_add needs a title.', lang);
      if (body.length > BODY_CAP) return pick(`본문이 너무 길다(${BODY_CAP.toLocaleString()}자까지) — 줄여서 다시 써라.`, `The body is too long (up to ${BODY_CAP} chars) — shorten it.`, lang);
      if (a.recipient === 'org' && !org) return pick('조직 전체 브리핑은 그 조직 안의 1:1에서만 보낼 수 있다(개인 공간 대화에서는 안 된다).', 'An organization-wide briefing can only be sent from a 1:1 inside that organization (not from the personal space).', lang);
      const data = { id: briefingDeps.newId(), title, body, kind: ['daily', 'weekly'].includes(a.kind) ? a.kind : 'custom', period: String(a.period ?? '').slice(0, 100),
        recipient: a.recipient === 'org' ? 'org' : undefined, author_kind: 'agent', author_name: String(crew ?? '').slice(0, 100) };
      const r = unwrap(await c.client.rpc('office_briefing_write', { p_org: org, p_action: 'briefing.create', p_data: data }));
      return pick(`브리핑을 남겼다: ${r?.title ?? title} — ${r?.org_wide ? '조직 구성원 모두의' : '주인의'} 오피스 '내 공간 > 브리핑'에서 볼 수 있다 (id=${r?.id ?? data.id})`,
        `Saved the briefing: ${r?.title ?? title} — visible in ${r?.org_wide ? 'every member\'s' : 'the owner\'s'} Office "My space > Briefings" (id=${r?.id ?? data.id})`, lang);
    }
    if (a.action === 'briefs' || a.action === 'brief_read') {
      if (a.action === 'brief_read') {
        if (!a.id) return pick('brief_read에는 briefs가 보여 준 id가 필요하다.', 'brief_read needs an id shown by briefs.', lang);
        const b = unwrap(await c.client.rpc('office_briefing_get', { p_id: a.id }));
        return [`${b.title} · ${b.org_wide ? pick('조직 전체', 'organization-wide', lang) : b.org_name ?? pick('개인 공간', 'personal', lang)} · ${b.author_name || '—'} · ${b.created_at}`, b.body || pick('(본문 없음)', '(empty)', lang)].join('\n');
      }
      const list = unwrap(await c.client.rpc('office_briefing_list', { p_before_at: null, p_before_id: null, p_q: a.q ? String(a.q).slice(0, 100) : null, p_limit: LIST_CAP, p_body: false })) ?? [];
      if (!list.length) return pick('받은 브리핑이 없다.', 'No briefings.', lang);
      return [pick(`최근 브리핑 ${list.length}건(제목 · 어디서 · 쓴 에이전트 · 언제 · id):`, `${list.length} recent briefings (title · from · author · when · id):`, lang),
        ...list.map((b) => `- ${b.title} · ${b.org_wide ? `${b.org_name} ${pick('전체', 'all', lang)}` : b.org_name ?? pick('개인 공간', 'personal', lang)} · ${b.author_name || '—'} · ${b.created_at} · id=${b.id}`),
        pick('본문은 brief_read에 id를 줘서 읽는다.', 'Read a body with brief_read and its id.', lang)].join('\n');
    }
    return pick('action은 brief_add·briefs·brief_read 중 하나다.', 'action must be brief_add, briefs or brief_read.', lang);
  } catch (e) { return refusalText(e, ERRORS, lang); }
}

export function briefingDescription(lang = 'ko') {
  return lang === 'en'
    ? 'Briefings in Argo Office — they collect in the recipient\'s Office "My space > Briefings". action=brief_add writes a briefing (title, body in Markdown up to 32KB, kind daily|weekly|custom, period like "2026-10-05" or "this week"); it goes to the owner by default, recipient="org" sends it to the whole organization (only when the owner is an organization admin). briefs lists recent briefings (q = search), brief_read reads one (id). Only available in a 1:1 with the owner. Briefings cannot be edited after writing.'
    : '아르고 오피스 브리핑 — 받는 사람의 오피스 \'내 공간 > 브리핑\'에 모인다. action=brief_add는 브리핑 쓰기(title, body는 마크다운 32KB까지, kind daily|weekly|custom, period 예: "2026-10-05"·"이번 주") — 기본은 주인에게, recipient="org"면 조직 전체(주인이 그 조직 관리자일 때만). briefs는 최근 브리핑 목록(q = 찾을 글자), brief_read는 한 건 읽기(id). 주인과의 1:1에서만 쓴다. 쓴 브리핑은 고칠 수 없다.';
}
