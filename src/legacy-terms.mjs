// 용어 표지 — 2026-10-05 용어 변경(크루→에이전트, 사장→사용자) 뒤에도 이미 저장된 기록과 사용자 습관을 그대로 읽기 위한 한 곳.
// 규칙: 쓰는 쪽은 새 값만 쓴다. 읽는 쪽은 새 값과 옛 값(OLD_*)을 함께 본다.
// **OLD_* 목록은 지우지 말고 더한다.** 하나라도 빼면 그 문구로 저장된 옛 대화·이벤트·회의 기록(다른 기기에서 동기화된 것 포함)을
// 못 알아본다 — test/legacy-terms.test.mjs가 옛 값을 글자 그대로 넣어 항목마다 잠근다.
// 노드 의존 0 — 클라이언트 번들(1:1 화면 카드·명패·러너 판정)에서도 가져다 쓴다. 용어 스캔(test/terms-scan.test.mjs)은 이 파일만 검사에서 뺀다.
// 계획: artifacts/rc-0195/terminology-plan.md 3절(M1~M6, M10, M11).

const freeze = (a) => Object.freeze([...a]);

// ── M1 회의실 화자 — room.mjs가 회의 대화 줄('화자: 발언')·회의록('**화자**:', '참석: 화자')에 쓰는 사용자 쪽 화자 ──
export const ROOM_USER_SPEAKER = '사용자';
export const OLD_ROOM_USER_SPEAKERS = freeze(['사장']);
/** 회의 대화 줄들 중 사용자의 마지막 발언 본문(없으면 null). 새 화자('사용자: ')가 한 줄이라도 있으면 새 기록이라 그것만 보고,
    없을 때만 옛 화자('사장: ')를 본다 — 새 기록에서 '사장'이라는 이름의 에이전트 발언을 사용자 발언으로 집지 않게. 맞은 접두어 길이만큼 자른다 */
export function lastRoomUserUtterance(lines) {
  for (const speaker of [ROOM_USER_SPEAKER, ...OLD_ROOM_USER_SPEAKERS]) {
    const head = `${speaker}: `;
    const hit = lines.filter((l) => l.startsWith(head)).pop();
    if (hit !== undefined) return hit.slice(head.length);
  }
  return null;
}

// ── M2 사용자가 멈춘 턴 — 활동 이벤트 error 문자열(chat.mjs). 판정은 aborted 필드가 먼저, 문자열은 그 필드가 없던 옛 이벤트용 ──
export const USER_ABORT_ERROR = '사용자 지시로 중단';
export const OLD_USER_ABORT_ERRORS = freeze(['사장 지시로 중단']);
export const isUserAbortError = (s) => s === USER_ABORT_ERROR || OLD_USER_ABORT_ERRORS.includes(s);
/** 턴 이벤트가 사용자 중단인가 — runner-usable.lastTurnByRunner·failure-digest가 같이 쓴다(두 판정이 어긋나지 않게) */
export const isAbortedTurnEvent = (e) => e?.aborted === true || isUserAbortError(e?.error);

// ── M3 결재 꼬리표 — 옛 값만. 새 값은 inbound-marks.mjs APPROVAL_TAG(쓰는 함수와 읽는 함수가 같은 파일) ──
export const OLD_APPROVAL_TAGS = Object.freeze({ owner: freeze(['(사장 결재)']), admin: freeze([]) });

// ── M4 회의실에서 공유한 쪽지의 머리말 — 옛 값만. 새 값은 inbound-marks.mjs mailHead. note = 참조(cc) 꼬리(MAIL_CC) 또는 '' ──
export const OLD_MAIL_SHARED_HEADS = Object.freeze({
  ko: freeze([(note) => `(사장이 회의실에서 공유${note}) `]),
  en: freeze([(note) => `(From the captain — shared from the meeting room${note}) `]),
});

// ── M5 텔레그램·슬랙 현황 명령 — 사용자가 치는 낱말(대소문자 무시, 앞 '/' 허용) ──
export const STATUS_COMMAND_WORDS = freeze(['에이전트', '현황', 'agent', 'agents', 'status']);
export const OLD_STATUS_COMMAND_WORDS = freeze(['크루', 'crew']);

// ── M6 CLI 명령 — 옛 이름 → 새 이름 ──
export const OLD_CLI_COMMANDS = Object.freeze({ crew: 'agent' });

// ── M10 명패 — company.owner에 사람 이름 대신 들어간 기본값(저장 값은 그대로 두고 표시만 바꾼다) ──
export const OWNER_PLACEHOLDERS = freeze(['captain']);

// ── 5-3 사용자 호칭 — 에이전트 지시문(systemPromptFor)에 한 줄. '하지 말라'는 호칭을 글자 그대로 담아 여기 둔다.
//    name·address는 user-name.mjs가 세척한 뒤 JSON 문자열(jsonText)로 만든 값 — 따옴표 안이 전부 데이터라 이름이 지시 줄을 만들 수 없다 ──
export const USER_ADDRESS_NOTE = Object.freeze({
  named: Object.freeze({
    ko: (name, address) => `사용자(이 에이전트의 주인)의 이름은 ${name}이다. 사용자를 부를 때는 ${address}이라고 부르고, '사장님'·'대표님' 같은 호칭은 쓰지 않는다.`,
    en: (name) => `The user's (your owner's) name is ${name}. Address them by name; do not call them 'boss' or 'captain'.`,
  }),
  unnamed: Object.freeze({
    ko: "사용자를 부를 때 '사장님'·'대표님'·'고객님' 같은 호칭을 쓰지 말고 바로 말한다.",
    en: "Do not address the user with titles such as 'boss' or 'captain'; speak to them directly.",
  }),
});

// ── M11 옛 기록 속 낱말 — 에이전트 지시문 공통 한 줄(chat.mjs systemPromptFor → SDK·CLI·네이티브 러너 모두). 이미 저장된 대화·요약·회의록·쪽지·
//    지침 파일(captain-rules.md·사장-프로필.md)은 고치지 않으므로, 모델이 옛 낱말을 다른 사람으로 읽지 않게 한 줄로 알려 준다 ──
export const LEGACY_RECORD_TERMS_NOTE = Object.freeze({
  ko: "옛 기록(지난 대화·요약·회의록·쪽지·지침 파일)에 나오는 '사장'·'captain'은 사용자를, '크루'·'crew'는 에이전트를 가리킨다.",
  en: "In older records (past conversations, summaries, meeting minutes, notes, rule files), '사장' and 'captain' mean the user, and '크루' and 'crew' mean an agent.",
});
