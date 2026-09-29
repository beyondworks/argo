// 크루에게 맡기기 — 오피스 항목(메일·페이지·파일·기록)을 크루와의 1:1 방에 보낼 글로 만든다(유건 9/29 확정, 계획 8절).
// 외부 자료는 "지시 아님" 표지로 감싸 지시와 분리하고, 메일·페이지 본문은 앞 8천 자까지만 싣는다.
// meta.source(office_*)는 게이트웨이가 이 턴의 풀 오토를 끄는 표지다(src/gateway/msgr-handoff.mjs fullAutoAllowed).

export const EXCERPT_MAX = 8000;
export const SOURCES = { mail: 'office_mail', page: 'office_page', file: 'office_file', record: 'office_record' };

/** 메일 HTML → 글자. 스크립트·스타일은 버리고 줄바꿈을 남긴다. parse는 테스트에서 바꿔 끼운다 */
export function htmlText(html, parse = (h) => new DOMParser().parseFromString(h, 'text/html')) {
  if (!html) return '';
  const doc = parse(String(html));
  doc.querySelectorAll('script, style, head').forEach((n) => n.remove());
  doc.querySelectorAll('br').forEach((n) => n.replaceWith('\n'));
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach((n) => n.append('\n'));
  return (doc.body?.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 페이지 본문(tiptap JSON) → 글자 */
export function docText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text ?? '';
  const inner = (node.content ?? []).map(docText).join(node.type === 'doc' || node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem', 'taskItem', 'blockquote', 'codeBlock'].includes(node.type) ? `${inner}\n` : inner;
}

export const BODY_BUDGET = 18000; // msgr_messages.body 상한 20000자 — 머리글·표지 몫을 남긴다
export const excerpt = (text, max = EXCERPT_MAX) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** 크루에게 보낼 글과 meta. items: [{ kind, id, label, from?, text? }] — text는 이미 글자로 바꾼 본문(없으면 이름만).
    t는 문구 사전(crew.msg.*) — 오피스 화면 언어로 표지를 쓴다 */
export function composeAssign({ instruction, items = [], t }) {
  const withText = items.filter((it) => String(it.text ?? '').trim()).length;
  const per = Math.min(EXCERPT_MAX, Math.floor(BODY_BUDGET / Math.max(1, withText))); // 여러 개를 맡기면 한 개당 몫을 나눈다
  const blocks = items.map((it) => {
    const head = [`[${t(`crew.msg.kind.${it.kind}`)}] ${it.label || ''}`.trim(), it.from ? `${t('crew.msg.from')}: ${it.from}` : null].filter(Boolean).join('\n');
    const body = excerpt(it.text, per);
    return body ? `${head}\n${body}` : head;
  });
  const body = blocks.length ? `${String(instruction).trim()}\n\n${t('crew.msg.fence')}\n${blocks.join('\n\n')}\n${t('crew.msg.end')}` : String(instruction).trim();
  const first = items[0];
  const meta = { source: SOURCES[first?.kind] ?? 'office_record', ...(first ? { office_ref: { kind: first.kind, id: String(first.id) } } : {}) };
  return { body, meta };
}

/** 서버 거절 사유 → 사용자 문구 키(i18n crew.fail.*) */
export const ASSIGN_REASONS = ['unentitled', 'locked', 'consent', 'not_allowed', 'no_crew', 'unavailable'];
const deny = (code) => Object.assign(new Error(`assign_${code}`), { transient: false, assign: code });

/** 내 크루와의 1:1 방에 글을 넣는다. db는 { rpc(fn, args), myChannels(), members(ids), insert(row) } — 오류 객체는 { code }를 가진다.
    서버가 뒤에서 조용히 멈출 조건(잠김·체험 끝·권한·AI 동의)은 보내기 전에 거절한다 — 보낸 뒤 아무 일도 안 일어나는 가짜 성공을 막는다(유건 9/29).
    반환: 'sent' | 'already'(같은 client_msg_id가 이미 들어감 — 앞선 시도가 응답만 잃었다). 거절은 { assign: 사유, transient: false }로 던진다 */
export async function deliverToCrew(db, { owner, orgId, crewId, crewName, body, meta, clientId }) {
  const [locked, entitled, check, consent] = await Promise.all([
    db.rpc('msgr_org_locked', { org: orgId }), db.rpc('msgr_org_entitled', { org: orgId }),
    db.rpc('msgr_instruct_check', { crew: crewId, author: owner, channel: null }), db.rpc('msgr_my_ai_consent', {}),
  ]).catch((e) => { throw e?.code === 'PGRST202' ? deny('unavailable') : e; }); // 확인 함수가 서버에 없다 — 다시 보내도 같으니 무한 재시도로 조용히 사라지지 않게 끝낸다
  if (locked === true) throw deny('locked');
  if (entitled !== true) throw deny(entitled === false ? 'unentitled' : 'not_allowed'); // null = 이 조직 멤버가 아님
  if (check !== 'ok') throw deny('not_allowed');
  if (!consent) throw deny('consent');
  const refused = (e) => { if (e?.code === 'P0001') throw deny('not_allowed'); throw e; }; // 서버 함수 거절(msgr_forbidden·msgr_bad_member·msgr_not_allowed) — 다시 보내도 같다
  const dmIds = (await db.myChannels()).filter((r) => r.msgr_channels?.kind === 'dm' && r.msgr_channels.org_id === orgId && !r.msgr_channels.archived_at).map((r) => r.channel_id);
  const members = dmIds.length ? await db.members(dmIds) : [];
  let channel = dmIds.find((cid) => { // 나 혼자 + 이 크루 하나인 방(메신저 openDm과 같은 판정)
    const ms = members.filter((m) => m.channel_id === cid);
    const users = ms.filter((m) => m.member_kind === 'user'), crews = ms.filter((m) => m.member_kind === 'crew');
    return users.length === 1 && users[0].member_id === owner && crews.length === 1 && crews[0].member_id === crewId;
  });
  if (!channel) channel = await db.rpc('msgr_create_channel', { org: orgId, kind: 'dm', name: `dm:${crewName ?? ''}`, others: [{ kind: 'crew', id: crewId }] }).catch(refused);
  try { await db.insert({ channel_id: channel, author_kind: 'user', author_user_id: owner, body, meta, client_msg_id: clientId }); }
  catch (e) { if (e?.code === '23505') return 'already'; refused(e); }
  return 'sent';
}
