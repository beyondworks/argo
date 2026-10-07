// 에이전트가 사용자를 이름으로 부르기(용어 변경 T5, 2026-10-05 유건 확정 — 이름이 있으면 이름으로, 없으면 호칭 없이).
// 계획: artifacts/rc-0195/terminology-plan.md 5절. 지시문 문장은 legacy-terms.mjs USER_ADDRESS_NOTE(하지 말라는 호칭을 글자 그대로 담아서).
//
// 이름을 얻는 곳(우선순위):
//   1. 메신저에서 주인이 직접 말한 턴 — msgr.mjs가 이미 읽은 사람 이름(ctx.ownerName). 추가 조회 없음.
//   2. 그 밖의 턴 — 기기 세션 파일에 저장해 둔 msgr_profiles.display_name(devicesession.mjs가 로그인 1회 + 하루 최대 1회만 읽는다).
//   3. 2가 없을 때 — company.owner가 사용자가 직접 적은 이름이면 그것('captain'·'회사 노드'·빈 값 제외). 회사 주인 계정이 지금 로그인한 계정과 다르면 쓰지 않는다.
//   4. 그래도 없으면 null — 호칭 없이 말한다.
// 남의 이름을 부르지 않는다: 손님 턴·에이전트가 넘긴 턴·오피스에서 맡긴 턴·메신저 위임 턴, 상주·워커(ARGO_TENANT_OWNER — 기기 세션이 서비스 계정이거나 없다),
// 회사 노드(company.msgr.nodeOrgId)는 이름을 넣지 않는다. 이름을 잘못 부르는 것보다 호칭 없이 말하는 쪽이 낫다.
// 턴마다 DB를 부르지 않는다 — 여기서는 파일만 읽는다.
import { loadDeviceSession } from './devicesession.mjs';
import { loadCompany } from './workspace.mjs';
import { OWNER_PLACEHOLDERS, USER_ADDRESS_NOTE } from './legacy-terms.mjs';
import { jsonText } from './inbound-marks.mjs';
import { isMessengerCtx } from './delegation-limits.mjs';
import { fullAutoAllowed } from './gateway/msgr-handoff.mjs';

export const USER_NAME_MAX = 40;
/** company.owner에 사람 이름 대신 들어가는 값 — 회사 노드(msgr-node.mjs createCompany) */
const NODE_OWNER = '회사 노드';
const tenantMode = (env = process.env) => !!env.ARGO_TENANT_OWNER?.trim();

/** 이름 세척(순수) — 줄 끝·제어·보이지 않는 서식 문자는 공백으로, 공백은 하나로, 앞뒤 공백 제거, 40자(코드 포인트). 남는 게 없으면 null.
    지시문에는 이 값을 JSON 문자열로만 싣는다(userAddressNote) — 세척은 길이·줄 모양을 정리하고, 경계는 따옴표 구조가 지킨다. */
export function cleanUserName(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const cut = Array.from(s).slice(0, USER_NAME_MAX).join('').trim();
  return cut || null;
}

/** 한국어 호칭 — 이미 '님'으로 끝나면 다시 붙이지 않는다('유건님' → '유건님', '유건님님' 아님). */
export const koAddress = (name) => (name.endsWith('님') ? name : `${name}님`);

/** 지시문 한 줄(순수) — 사용자가 정한 호칭 규칙이 있으면(ruled) 그 규칙을 따르라는 줄, 아니면 이름이 있으면 이름과 부를 말, 없으면 호칭 없이 말하라는 줄. */
export function userAddressNote(name, lang = 'ko', { ruled = false } = {}) {
  const n = cleanUserName(name);
  const l = lang === 'en' ? 'en' : 'ko';
  if (ruled) return USER_ADDRESS_NOTE.ruled[l]; // 유건 결정 2026-10-08 ③ — 사용자가 정한 규칙이 공간별 표시 이름 지시보다 우선
  if (!n) return USER_ADDRESS_NOTE.unnamed[l];
  return l === 'en' ? USER_ADDRESS_NOTE.named.en(jsonText(n)) : USER_ADDRESS_NOTE.named.ko(jsonText(n), jsonText(koAddress(n)));
}

/* ── 사용자가 정한 호칭 규칙(유건 결정 2026-10-08 ③) — 카드 '## 일하는 방식'이나 확정 규칙(교정에서 채택한 회사 스킬 captain-rules.md)에
   호칭 규칙이 있으면, 메신저 공간마다 다른 표시 이름으로 "이 이름으로 불러라"는 지시를 넣지 않는다(그 규칙을 따르라는 한 줄로 바꾼다).
   판정은 줄 단위 낱말 규칙이다 — 놓치면 종전 이름 지시가 남을 뿐이고(지금과 같음), 잘못 잡으면 이름 대신 "정한 규칙대로"가 실린다. ── */
export const ADDRESS_RULE_SKILL = 'captain-rules.md'; // corrections.mjs RULES_SKILL과 같은 파일(가져오면 러너 모듈까지 끌려와 이름만 맞춘다 — 테스트가 잠근다)
// 한 줄이 호칭 규칙인가 = 부르는 말(ADDRESS_CALL·영어 ADDRESS_EN)이 있고 그 대상이 사용자다. 대상이 사용자로 적혀 있으면(나를·사용자를·내 이름·me…) 참,
// 다른 사람(고객·상대·거래처·손님·메일·너 …)만 적혀 있으면 거짓(검수 LOW 2026-10-08: '고객은 고객님이라고 부른다'·'너를 서윤이라고 부를게'를 잡고 '나를 대표님이라 불러'·'대표님이라고 해줘'를 놓치던 것).
// 대상 낱말이 없을 때는 부르는 말과 같은 절 안, 그 앞에 '은/는/을/를'이 붙은 다른 낱말이 있으면 그 낱말의 이름을 정한 줄로 보고 거짓('보고서 제목은 "주간 보고"라고 부른다'·
// '함수는 helper로 불러 쓴다' — 재검수 LOW 2026-10-08: 확정 규칙은 모든 에이전트에 실려 용어 교정 한 줄이 회사 전체의 이름 지시를 바꾸던 것), 없으면("대표님이라고 해줘") 사용자에게 하는 말로 보고 참.
// 앞 절의 낱말('반말은 쓰지 말고 유건님이라고 불러'·'존댓말을 쓰고 …'·'보고는 결론부터, 그리고 …')은 부르는 대상이 아니다(재검수 LOW 2026-10-08 2차: 같은 줄 앞의 다른 지시가 참을 거짓으로 바꾸던 것).
const ADDRESS_CALL = new RegExp([
  '호칭',
  '이?라(?:고)?\\s*(?:불러(?![오와온올들])|부르|부를|부른|칭하|칭해)', // ~이라(고) 불러 · ~라 칭해 — '불러오다'(자료를 ~라고 불러온다)는 아니다
  '로\\s*(?:불러(?![오와온올들서])|부르|부를|부른|칭하|칭해)', // ~(으)로 불러 — '불러오다'(자료를 ~로 불러온다)·'불러서'(도구로 불러서 처리한다)는 아니다
  '님(?:이)?라(?:고)?\\s*(?:해|하)', // ~님이라고 해(줘) — '님'까지 있어야('"출처 없음"이라고 해'는 호칭이 아니다)
  '(?:사용자|주인|유저|(?<![가-힣])나|(?<![가-힣])저)(?:를|을)\\s*(?:부를|부르|불러(?![오와온올들])|부른)', // 나를 부를 때는 …
  '(?<![가-힣])(?:내|제)\\s*이름(?:을|를|은|도)?\\s*(?:부를|부르|불러(?![오와온올들])|부른)', // 내 이름을 부르지 마 · 제 이름은 부르지 말고
].join('|'));
const ADDRESS_EN = /\b(?:call|address|refer to)\s+(?:me|the user|the owner)\b(?!['’]s)/i;
const USER_TARGET = /(?<![가-힣])(?:나|날|저)(?:를|을|는|은|도|한테|에게)?(?![가-힣])|(?<![가-힣])(?:내|제)\s*(?:이름|(?:직함|성함|성|호칭)(?:은|는|을|를|도|이|만|으로|로)?(?![가-힣]))|사용자|주인|유저/;
// 사용자 자신의 이름·직함·성·호칭 — 줄 머리('- 이름은 유건님으로 불러줘')나 때를 정하는 말 뒤('앞으로 이름은 …'), 내/제 뒤('제 직함은 빼고'). 다른 낱말 뒤('프로젝트 이름은 …')는 그 낱말의 이름이다.
const SELF_NAME = /^(?:이름|직함|성함|성|호칭)(?:은|는|을|를|도)?$/;
const SELF_LEAD = /^(?:내|제|앞으로는?|이제부터|이제|지금부터|항상|늘|꼭)$/;
const selfName = (line) => { const w = line.replace(/^[\s\-*•·]+/, '').split(/\s+/).map((x) => x.replace(/[,，;"'“”‘’]/g, '')); return w.some((x, i) => SELF_NAME.test(x) && (i === 0 || SELF_LEAD.test(w[i - 1]))); };
const OTHER_TARGET = /고객|상대|거래처|손님|메일|동료|직원|팀원|다른 사람|(?<![가-힣])남(?:을|은|에게|한테)(?![가-힣])|(?<![가-힣])너(?:를|는|도|의|한테|에게)?(?![가-힣])/;
// 부르는 말 앞의 '<낱말>은/는/을/를' — 이름을 정하는 대상(제목은·프로젝트를·함수는·API를 …). 때·경우('말할 때는')와 '-하는/-되는/-있는/-없는'(꾸미는 말)은 대상이 아니다.
const NAMED_THING = /([가-힣A-Za-z0-9]+?)(?:은|는|을|를)(?=[\s"'“”‘’]|$)/g;
const NOT_THING = /^(?:때|경우)$|(?:하|되|있|없)$/;
// 절 경계 — 쉼표·쌍반점, '-고 / -면 / -며 / -지만 / -는데' 뒤 띄어쓰기(말고·빼고·쓰고·그리고·필요하면 …). 부르는 말 앞의 마지막 경계 뒤만 같은 절로 본다.
const CLAUSE_CUT = /[,，;]|[가-힣]*(?:고|면|며|지만|는데)(?=\s)/g;
const sameClause = (pre) => { let at = 0; for (const m of pre.matchAll(CLAUSE_CUT)) at = m.index + m[0].length; return pre.slice(at); };
const addressRuleLine = (line) => {
  if (ADDRESS_EN.test(line)) return true;
  const call = ADDRESS_CALL.exec(line);
  if (!call) return false;
  if (USER_TARGET.test(line) || selfName(line)) return true;
  return !OTHER_TARGET.test(line) && ![...sameClause(line.slice(0, call.index)).matchAll(NAMED_THING)].some(([, stem]) => !NOT_THING.test(stem));
};
/** 글에 호칭 규칙 줄이 있는가(순수) */
export const hasAddressRule = (text) => String(text ?? '').split('\n').some(addressRuleLine);
const RULES_BLOCK_RE = new RegExp(`### (?:스킬|Skill): ${ADDRESS_RULE_SKILL.replace(/\.md$/, '')}\\n([\\s\\S]*?)(?=\\n### (?:스킬|Skill): |$)`); // 주입 머리의 스킬 id는 확장자 없는 이름(chat.mjs loadSkills ← market.mjs readInstalledSkills)
/** 사용자가 호칭을 직접 정했는가(순수) — 카드 '## 일하는 방식' 절 + 이번 턴에 주입된 확정 규칙 본문(skills 문자열의 captain-rules.md 절).
    주입 예산 때문에 본문이 빠진 확정 규칙은 모델도 못 보므로 보지 않는다. */
export function userSetAddress(cardMd, skills) {
  const rules = String(cardMd ?? '').match(/## 일하는 방식\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  const adopted = String(skills ?? '').match(RULES_BLOCK_RE)?.[1] ?? '';
  return hasAddressRule(rules) || hasAddressRule(adopted);
}

/** company.owner가 사용자가 직접 적은 이름인가 — 기본값('captain')·회사 노드·빈 값은 이름이 아니다. */
function typedOwnerName(company) {
  const v = cleanUserName(company?.owner);
  return v && !OWNER_PLACEHOLDERS.includes(v) && v !== NODE_OWNER ? v : null;
}

/** 이 회사의 사용자 이름(세척 값) 또는 null — 기기 세션 이름 → company.owner(직접 적은 이름) → null. 파일만 읽는다(DB 호출 0).
    company를 넘기면 다시 읽지 않는다. uid를 넘기면 기기 세션 계정이 그 계정일 때만 기기 세션 이름을 쓴다(메신저 턴의 크루 주인). */
export async function userDisplayName(wsId, { company = undefined, uid = null, env = process.env } = {}) {
  if (tenantMode(env)) return null;
  const co = company !== undefined ? company : (wsId ? await loadCompany(wsId).catch(() => null) : null);
  if (co?.msgr?.nodeOrgId) return null;
  const sess = loadDeviceSession();
  const sessUid = sess?.user?.id ?? null;
  if (uid && sessUid !== uid) return null;
  const fromSession = cleanUserName(sess?.user?.name);
  if (fromSession) return fromSession;
  const typed = typedOwnerName(co);
  if (!typed) return null;
  // 회사 주인 계정이 있으면 지금 로그인한 그 계정일 때만(계정 전환 뒤 남의 회사에 적힌 이름을 부르지 않는다). 주인 없는 회사(게스트·셀프호스트)는 그대로.
  if (co?.ownerId && co.ownerId !== sessUid) return null;
  return typed;
}

/** 이번 턴에 지시문에 넣을 사용자 이름 또는 null — runChat이 턴 시작에 한 번 부른다. */
export async function turnUserName(wsId, { mirrorCtx = null, company = undefined, env = process.env } = {}) {
  if (tenantMode(env)) return null;
  if (isMessengerCtx(mirrorCtx)) {
    // 메신저 맥락은 주인이 직접 시킨 채널·DM 턴(kind 'msgr' + 손님·오피스·넘김 아님)만. 위임받은 동료 턴('msgr-rules')은 누가 시켰는지 맥락이 없다.
    if (mirrorCtx.kind !== 'msgr' || !fullAutoAllowed(mirrorCtx)) return null;
    return cleanUserName(mirrorCtx.ownerName) ?? userDisplayName(wsId, { company, uid: mirrorCtx.uid ?? null, env });
  }
  return userDisplayName(wsId, { company, env });
}
