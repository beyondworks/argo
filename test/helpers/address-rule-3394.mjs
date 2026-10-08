// 호칭 규칙 판정의 기준판 — 3394f000(6차) src/user-name.mjs의 hasAddressRule을 글자 그대로 옮긴 고정 사본. 고치지 않는다.
// 9차(2026-10-08 총괄 결정): 지금 판정은 이 판정의 부분집합이어야 한다(지금 판정이 참이면 이것도 참 — 3394 대비 새 오탐 0).
// test/agent-one-person-rules.test.mjs의 성질 테스트가 표 전체와 조합으로 만든 줄에서 대조한다.
const ADDRESS_CALL = new RegExp([
  '호칭',
  '이?라(?:고)?\\s*(?:불러(?![오와온올들])|부르|부를|부른|칭하|칭해)', // ~이라(고) 불러 · ~라 칭해 — '불러오다'(자료를 ~라고 불러온다)는 아니다
  '로\\s*(?:불러(?![오와온올들서])|부르|부를|부른|칭하|칭해)', // ~(으)로 불러 — '불러오다'(자료를 ~로 불러온다)·'불러서'(도구로 불러서 처리한다)는 아니다
  '님(?:이)?라(?:고)?\\s*(?:해|하)', // ~님이라고 해(줘) — '님'까지 있어야('"출처 없음"이라고 해'는 호칭이 아니다)
  '(?:사용자|주인|유저|(?<![가-힣])나|(?<![가-힣])저)(?:를|을)\\s*(?:부를|부르|불러(?![오와온올들])|부른)', // 나를 부를 때는 …
  '(?<![가-힣])(?:내|제)\\s*이름(?:을|를|은|도)?\\s*(?:부를|부르|불러(?![오와온올들])|부른)', // 내 이름을 부르지 마 · 제 이름은 부르지 말고
].join('|'));
// 영어 — 'me' 바로 뒤가 때·조건을 정하는 말(only·when·if·back …)이면 부르는 말이 아니라 연락하라는 말이고('Call me only when you are blocked'),
// 'the user/the owner' 바로 뒤에 낱말이 오면 그 낱말이 대상이다('Refer to the user manual'·'Address the user stories' — 재검수 4차 LOW). 뒤가 끝·문장부호·as/by일 때만 참.
const ADDRESS_EN = /\b(?:call|address|refer to)\s+(?:me\b(?!['’]s)(?!\s+(?:only|when|whenever|if|unless|back|before|after|once|again|anytime|at|on|for|about|with|later|first)\b)|the (?:user|owner)\b(?!['’]s)(?=\s*(?:$|[.,;:!?)"'“”‘’]|(?:as|by)\b)))/i;
// '사용자·주인·유저'는 바로 뒤에 조사(를·을·에게·한테·은·는·도)가 붙고 그다음이 한글이 아닐 때, 또는 '사용자 호칭은'처럼 그 사람의 이름·호칭을 가리킬 때만 사용자다.
// '사용자 매뉴얼은'·'사용자의 고객은'·'유저 스토리는'·'주인공은'·'"사용자"라고'는 다른 낱말이 대상이다(재검수 4차 LOW — 교정 채택 한 줄이 모든 에이전트의 호칭 지시를 바꾸던 것).
// 단독 '저'는 조사가 붙을 때만('저를·저는' — '저 장표는'의 '저'는 가리키는 말이다).
const USER_TARGET = /(?<![가-힣])(?:나|날)(?:를|을|는|은|도|한테|에게)?(?![가-힣])|(?<![가-힣])저(?:를|을|는|은|도|한테|에게)(?![가-힣])|(?<![가-힣])(?:내|제)\s*(?:이름|(?:직함|성함|성|호칭)(?:은|는|을|를|도|이|만|으로|로)?(?![가-힣]))|(?<![가-힣])(?:사용자|주인|유저)(?:(?:를|을|에게|한테|은|는|도)(?![가-힣])|\s*(?:호칭|이름|직함|성함)(?:은|는|을|를|도|이|으로|로)(?![가-힣]))/;
// 사용자 자신의 이름·직함·성·호칭 — 줄 머리('- 이름은 유건님으로 불러줘')나 때를 정하는 말 뒤('앞으로 이름은 …'), 내/제 뒤('제 직함은 빼고'). 다른 낱말 뒤('프로젝트 이름은 …')는 그 낱말의 이름이다.
const SELF_NAME = /^(?:이름|직함|성함|성|호칭)(?:은|는|을|를|도)?$/;
const SELF_LEAD = /^(?:내|제|앞으로는?|이제부터|이제|지금부터|항상|늘|꼭)$/;
const selfName = (line) => { const w = line.replace(/^[\s\-*•·]+/, '').split(/\s+/).map((x) => x.replace(/[,，;"'“”‘’]/g, '')); return w.some((x, i) => SELF_NAME.test(x) && (i === 0 || SELF_LEAD.test(w[i - 1]))); };
const OTHER_TARGET = /고객|상대|거래처|손님|메일|동료|직원|팀원|다른 사람|(?<![가-힣])서로(?![가-힣])|(?<![가-힣])남(?:을|은|에게|한테)(?![가-힣])|(?<![가-힣])너(?:를|는|도|의|한테|에게)?(?![가-힣])/;
// 부르는 말 앞의 '<낱말>은/는/을/를' — 이름을 정하는 대상(제목은·프로젝트를·함수는·API를 …). 때·경우('말할 때는')와 '-하는/-되는/-있는/-없는'(꾸미는 말)은 대상이 아니다.
const NAMED_THING = /([가-힣A-Za-z0-9]+?)(?:은|는|을|를)(?=[\s"'“”‘’,，]|$)/g; // 뒤에 쉼표가 와도('프로젝트 이름은, 앞으로 …')
const NOT_THING = /^(?:때|경우)$|(?:하|되|있|없)$/;
// 절 경계는 두 가지다(재검수 3차 LOW 2026-10-08: 모든 '-고/-면'에서 끊으니 '회의록은 정리하고 "스탠드업"이라고 부른다'처럼 앞 절의 주제어가 뒤 절까지 걸리는 줄을 참으로 잡았다).
//   끊는 경계 — 문장 끝·쌍반점·'그리고/또'(앞 지시와 따로인 새 지시). 그 앞 낱말은 보지 않는다('보고는 결론부터, 그리고 …').
//   잇는 경계 — 쉼표·'-고 / -면 / -며 / -지만 / -는데' 뒤 띄어쓰기. 앞 절의 '은/는/을/를' 낱말은 뒤 절의 대상일 수 있어 그대로 본다.
//     예외: 말투 낱말이 주제인 절('반말은 쓰지 말고 …'·'존댓말을 쓰고 …'), '말고/빼고'로 끝나는 절(그 낱말은 빼라는 것 — '대표님은 말고 …').
// 놓치면 종전 이름 지시가 남을 뿐이라(지금과 같음) 애매하면 대상으로 본다.
const HARD_CUT = /[.!?。](?=\s)|[;；]|(?<![가-힣])(?:그리고|또한?|그다음에?)(?![가-힣])/g; // 마침표는 뒤가 띄어쓰기일 때만('v2.0이라고 부른다'의 점은 문장 끝이 아니다)
const SOFT_CUT = /[,，]|[가-힣]*(?:고|면|며|지만|는데)(?=[\s,，])/g;
const SPEECH_STYLE = /^(?:반말|존댓말|존대|높임말|말투|어투|말씨|경어|존칭)$/;
const EXCEPT_END = /(?:말|빼)고[\s,，]*$/;
const afterHardCut = (pre) => { let at = 0; for (const m of pre.matchAll(HARD_CUT)) at = m.index + m[0].length; return pre.slice(at); };
/** 부르는 말 앞(같은 문장)에 이름을 정하는 다른 대상이 있는가 — 마지막 절은 그대로, 앞 절은 위 예외만 뺀다 */
const namedBefore = (pre) => {
  const seg = afterHardCut(pre);
  let from = 0; const clauses = [];
  for (const m of seg.matchAll(SOFT_CUT)) { clauses.push({ text: seg.slice(from, m.index + m[0].length), front: true }); from = m.index + m[0].length; }
  clauses.push({ text: seg.slice(from), front: false });
  return clauses.some(({ text, front }) => [...text.matchAll(NAMED_THING)].some(([, stem]) => !NOT_THING.test(stem) && !(front && (SPEECH_STYLE.test(stem) || EXCEPT_END.test(text)))));
};
// '<낱말> 호칭은 …' — 그 낱말의 호칭(문서 호칭·상대방 호칭). 때·곳을 정하는 말(대화에서·말할 때)·이어 주는 말은 대상이 아니다. 사용자 자신의 호칭('호칭은 …'·'앞으로 호칭은 …')은 selfName이 먼저 잡는다.
const NOT_OWNER_WORD = /(?:에서|에선|에는|에게|한테|에|때|땐|경우|고|면|며|지만|는데|그리고|또)$/;
const thingAddress = (pre) => { const w = afterHardCut(pre).replace(/^[\s\-*•·]+/, '').split(/[\s,，]+/).filter(Boolean).at(-1); return !!w && !NOT_OWNER_WORD.test(w) && !SELF_LEAD.test(w); };
const addressRuleLine = (line) => {
  if (ADDRESS_EN.test(line)) return true;
  const call = ADDRESS_CALL.exec(line);
  if (!call) return false;
  if (USER_TARGET.test(line) || selfName(line)) return true;
  if (OTHER_TARGET.test(line)) return false;
  const pre = line.slice(0, call.index);
  if (call[0] === '호칭' && thingAddress(pre)) return false;
  return !namedBefore(pre);
};
/** 글에 호칭 규칙 줄이 있는가(순수) */
export const hasAddressRule3394 = (text) => String(text ?? '').split('\n').some(addressRuleLine);
