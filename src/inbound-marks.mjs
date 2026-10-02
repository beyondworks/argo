// 바깥에서 들어온 글의 머리말 형식 — 한 곳에서 만든다.
// 크루 1:1 대화 기록의 who:'user' 중에는 사장이 이 방에서 직접 치지 않은 글(메신저·루틴·쪽지·위임·장시간 작업·결재 결과)이 섞인다.
// 이 글을 만드는 쪽(프롬프트 조립)과 1:1 화면의 출처 카드(app/c/[ws]/crew/[slug]/inbound-card.mjs)가 **같은 함수**를 써서
// 머리말 문구가 바뀌어도 둘이 어긋나지 않게 한다. 문구를 바꾸면 이미 저장된 기록은 옛 형식으로 남으므로, 그때는 파서에
// 옛 형식을 지우지 말고 더한다. 노드 의존 0 — 클라이언트 번들에서도 가져다 쓴다.

const L = (lang) => (lang === 'en' ? 'en' : 'ko');
const HOLE = '\u0000'; // 머리말 안 이름 자리 — 같은 생성 함수로 앞·뒤 고정 문자열을 얻어 파싱에 쓴다

/** 이름 하나가 들어가는 머리말을 생성 함수로 다시 만들어 맞춰 본다. 맞으면 { value(이름), rest(머리말 뒤 본문) } */
function matchHead(text, build) {
  const [pre, suf] = build(HOLE).split(HOLE);
  if (!text.startsWith(pre)) return null;
  const i = text.indexOf(suf, pre.length);
  if (i < 0) return null;
  const value = text.slice(pre.length, i);
  if (value.includes('\n') || value.length > 200) return null; // 이름 자리는 한 줄·짧다(세척된 이름)
  return { value, rest: text.slice(i + suf.length) };
}

// ── 루틴·루프 — `[루틴: 제목] 지시` (첫 실행은 ko 고정, 재시도는 회사 언어 — routines.mjs) ──
export const routineHead = (title, lang = 'ko') => (L(lang) === 'en' ? `[Routine: ${title}]` : `[루틴: ${title}]`);
export const LOOP_MARK = { ko: '[루프 프로토콜]', en: '[Loop protocol]' };
/** 루프 프로토콜 문단의 시작 — 루프 지시는 `지시 + loopHead + 회차 안내` 모양이다 */
export const loopHead = (lang = 'ko') => `\n\n---\n${LOOP_MARK[L(lang)]}`;

export function parseRoutine(text) {
  for (const lang of ['ko', 'en']) {
    const h = matchHead(text, (t) => `${routineHead(t, lang)} `);
    if (!h) continue;
    const cuts = ['ko', 'en'].map((l) => h.rest.indexOf(loopHead(l))).filter((i) => i >= 0);
    return { title: h.value, loop: cuts.length > 0, body: cuts.length ? h.rest.slice(0, Math.min(...cuts)) : h.rest };
  }
  return null;
}

// ── 팀 메신저 — `[팀 메신저 #채널 — …]\n(최근 채널 대화)\n[지금 메시지]\n이름: 본문` (gateway/msgr.mjs) ──
export const msgrHead = (channel, lang = 'ko') => (L(lang) === 'en' ? `[Team messenger #${channel} — ` : `[팀 메신저 #${channel} — `);
export const MSGR_NOW = { ko: '[지금 메시지]', en: '[Current message]' };

/** authorName = 본문 줄 앞에 붙는 발화자 이름(넘긴 턴이면 넘긴 크루) — 있으면 떼어 낸다 */
export function parseMsgr(text, authorName = '') {
  for (const lang of ['ko', 'en']) {
    const h = matchHead(text, (c) => msgrHead(c, lang));
    if (!h) continue;
    // 머리말은 한 줄이다(채널명·이름 세척). 채널 대화가 있으면 [지금 메시지] 뒤가 본문, 없으면 머리말 다음 줄부터.
    const now = h.rest.indexOf(`\n${MSGR_NOW[lang]}\n`);
    const nl = h.rest.indexOf('\n');
    let body = now >= 0 ? h.rest.slice(now + MSGR_NOW[lang].length + 2) : nl >= 0 ? h.rest.slice(nl + 1) : '';
    if (authorName && body.startsWith(`${authorName}: `)) body = body.slice(authorName.length + 2);
    return { channel: h.value, body };
  }
  return null;
}

// ── 쪽지(crewmail) — crewmail.mjs mailPrompt ──
export const MAIL_CC = { ko: ' (참조 — 알아두라고 보낸 사본이다. 회신 의무는 없다)', en: ' (CC — for your awareness; no reply expected)' };
/** 쪽지 머리말. captain = 사장이 회의실에서 참조로 돌린 것 */
export function mailHead(lang, { fromName = '', cc = false, captain = false } = {}) {
  const l = L(lang);
  const note = cc ? MAIL_CC[l] : '';
  if (captain) return l === 'en' ? `(From the captain — shared from the meeting room${note}) ` : `(사장이 회의실에서 공유${note}) `;
  return l === 'en' ? `(Message from colleague ${fromName}${note}) ` : `(동료 ${fromName}의 쪽지${note}) `;
}
/** 회신 가능한 쪽지 끝에 붙는 안내 줄 */
export const mailReplyHint = (lang, fromName) => (L(lang) === 'en'
  ? `\n(If a reply is needed, use send_to_crew to message ${fromName} back.)`
  : `\n(회신이 필요하면 send_to_crew 도구로 ${fromName}에게 답장을 보내라.)`);

export function parseMail(text) {
  for (const lang of ['ko', 'en']) {
    for (const cc of [true, false]) {
      const cap = mailHead(lang, { cc, captain: true });
      if (text.startsWith(cap)) return { captain: true, cc, fromName: '', body: text.slice(cap.length) };
      const h = matchHead(text, (n) => mailHead(lang, { fromName: n, cc }));
      if (!h) continue;
      const hint = mailReplyHint(lang, h.value);
      return { captain: false, cc, fromName: h.value, body: h.rest.endsWith(hint) ? h.rest.slice(0, -hint.length) : h.rest };
    }
  }
  return null;
}

// ── 위임 — chat.mjs delegate_to_crew ──
export const delegateHead = (lang, fromName) => (L(lang) === 'en' ? `(Delegated by colleague ${fromName}) ` : `(동료 ${fromName}의 위임) `);
export function parseDelegate(text) {
  for (const lang of ['ko', 'en']) {
    const h = matchHead(text, (n) => delegateHead(lang, n));
    if (h) return { fromName: h.value, body: h.rest };
  }
  return null;
}

// ── 장시간 작업 — gateway.mjs 작업 큐(기록은 제목만) ──
export const jobHead = (lang) => (L(lang) === 'en' ? '(Long task) ' : '(장시간 작업) ');
export function parseJob(text) {
  for (const lang of ['ko', 'en']) if (text.startsWith(jobHead(lang))) return { body: text.slice(jobHead(lang).length) };
  return null;
}

// ── 결재 결과 — approval-actions.mjs 후속 턴. 이 기록만 via가 없어 머리말로 판정한다 ──
export const APPROVAL_TAG = { owner: '(사장 결재)', admin: '(관리자 결재)' };
export function parseApproval(text) {
  for (const by of ['owner', 'admin']) if (text.startsWith(`${APPROVAL_TAG[by]} `)) return { by, body: text.slice(APPROVAL_TAG[by].length + 1) };
  return null;
}
