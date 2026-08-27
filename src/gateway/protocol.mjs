// 메신저 프로토콜 순수 판정 — 문자열이 들어와 판정이 나간다. 네트워크·파일·타이머 없음(단위 테스트 이음매).
// gateway.mjs 분해: 옮긴 코드는 원문 그대로(행동 불변) — 주석 동반 이동. 신규는 기존 인라인 정규식을
// 함수로 뽑은 파서 3개(parseApprovalText·parseApprovalCallback·pairCodeMatches)뿐 — 정규식·판정은 원문과 동일.

import { channelSends } from '../channel-events.mjs'; // 발송 판정 정본 — 사본 금지(channel-mute 계약)

const MAX_MSG = 3800; // 텔레그램 4096 제한 대비 여유
export const clip = (t) => (t.length > MAX_MSG ? `${t.slice(0, MAX_MSG)}\n…(전체 내용은 Argo 데크에서)` : t);

// 폴 오류 백오프 — 특히 getUpdates Conflict(같은 봇 토큰을 다른 인스턴스/기기가 폴링)는
// 자연 치유(멀티기기 리더 전환 순간 겹침)이지만, 5초 고정 재시도는 지속 중복(같은 봇을 두 회사에
// 연결 등) 시 텔레그램 API를 영원히 때린다(실측 2026-07-24: Conflict 하트비트 반복). 연속 실패에
// 지수 백오프(5s→최대 60s)를 걸어 배틀 부하를 없앤다. 성공하면 리셋. 정지는 하지 않는다 —
// Conflict가 풀리면(다른 인스턴스 종료) 그대로 재개해야 하므로(자동 정지는 재개 배선이 필요해 위험).
const POLL_BACKOFF_BASE_MS = 5000;
const POLL_BACKOFF_MAX_MS = 60_000;
export const pollBackoffMs = (streak) => Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * 2 ** Math.max(0, streak - 1));

// 회사 시스템 언어(ko|en) 기반 코드 방출 문자열 선택. 기존 회사(lang 없음/'ko')는 항상 ko 반환 → 기존 동작 그대로.
export const pick = (ko, en, lang) => (lang === 'en' ? en : ko);

/** 크루가 만든 결재 문구(action·reason) 정돈 — 모델 출력의 줄머리 공백·과잉 개행이 텔레그램 말풍선을
    울퉁불퉁하게 만들던 것(실사용 신고 2026-07-25 "말풍선 찌그러짐") 방지. 내용은 보존, 모양만 편다.
    코드펜스(```) 안은 원문 보존(사후 검수 M/L-5) — 결재는 승인 판단 표면이라 들여쓰기가 곧 내용이다. */
export const tidy = (s) => String(s ?? '')
  .split(/(```[\s\S]*?```)/)
  .map((seg, i) => (i % 2 ? seg : seg.replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n')))
  .join('')
  .trim();

/** 텍스트 결재 회신 파서 — "승인 ap-xxx" / "거절 ap-xxx" (슬랙·텔레그램 공용). 결재 토큰(승인/거절)은
    파서 앵커라 고정. verb = 원문 동사(응답 문구에 그대로 쓰인다). 형식이 아니면 null(일반 지시). */
export function parseApprovalText(text) {
  const m = String(text ?? '').match(/^(승인|거절)\s+(ap-[a-z0-9]+)/);
  return m ? { verb: m[1], approve: m[1] === '승인', id: m[2] } : null;
}

/** 결재 인라인 버튼 콜백 파서 — callback_data "ap:<결재id>:<1=승인|0=거절>". 형식 밖이면 null(무시). */
export function parseApprovalCallback(data) {
  const m = String(data ?? '').match(/^ap:(ap-[a-z0-9]+):([01])$/);
  return m ? { id: m[1], approve: m[2] === '1' } : null;
}

/** 페어링 코드 판정 — 설정에 표시된 코드(대문자 발급)를 보낸 사람만 사장으로 고정(TOFU 차단).
    코드 미발급('')이면 항상 불일치 — 아무나 먼저 말 걸어도 소유권을 못 가져간다. 비교는 원문과 동일:
    수신 텍스트 trim + 대문자 정규화 후 저장 코드와 전등호. */
export function pairCodeMatches(pairCode, text) {
  return !!pairCode && String(text ?? '').trim().toUpperCase() === pairCode;
}

/** 브리핑(routine·job·crewmail·inbox)·결재(approval)의 텔레그램 목적지 판정(순수) — 회사
    게이트웨이가 우선이고, 게이트웨이가 못 보내면(꺼짐·미페어링·음소거 아님) **담당 크루의 직통 봇**으로 폴백한다.
    경위(실사용 2026-08-27): 회사 게이트웨이 enabled=false + 크루 직통 봇 8개만 페어링된 회사에서
    루틴이 51회 ok로 끝나고도 텔레그램에 0회 도착 — 브리핑 발송이 게이트웨이 단일 경로라
    channelSends에서 전량 무음 탈락했고, 직통 봇으로 가는 경로 자체가 없었다.
    규칙: ① 판정은 정본 channelSends만 쓴다(사본 금지 — channel-mute 계약). ② 직통 봇은
    "토큰 = 연결"(별도 토글 없음 — gateway 매니저와 같은 의미)이라 enabled만 참으로 두되,
    회사 채널의 음소거(mutedEvents)는 폴백에서도 그대로 존중한다. ③ 결재(approval)도 폴백한다 —
    직통 봇 폴러가 callback_query를 처리하게 되어(handleApprovalCallback 공용) 인라인 버튼이
    살아 있다(PR #305에서 죽은 버튼 사유로 제외했던 비대칭 해소). 폴백 반환의 botSlug는
    카드가 실린 봇의 귀속 표식 — 결재 후속(approval_resolved·approval_followup)이 같은 봇
    토큰으로 그 카드를 편집·회신하는 데 쓴다.
    inbox는 알림 버스(onNotify)가 아니라 inbox 감시자가 직접 부른다 — 담당 크루 개념이 없어
    처리 크루(기본 크루)의 slug를 넘긴다(분리 검수 LOW-1: 루틴·작업·쪽지는 폴백으로 오는데
    받은 서류함만 못 받는 비대칭 해소). pushEvent에는 inbox 이벤트가 오지 않으므로 이중 발송 없음.
    반환: { token, chatId } · { token, chatId, botSlug }(직통 봇 폴백) · null(보낼 곳 없음). */
export const TG_BRIEFING_TYPES = Object.freeze(['routine', 'job', 'crewmail', 'inbox', 'approval']);
export function telegramBriefingDest(tg, type, slug) {
  if (!TG_BRIEFING_TYPES.includes(type)) return null;
  if (tg?.token && tg.chatId && channelSends('telegram', tg, type)) return { token: tg.token, chatId: tg.chatId };
  const bot = tg?.agents?.[slug];
  if (bot?.token && bot.ownerChat && channelSends('telegram', { enabled: true, mutedEvents: tg?.mutedEvents }, type)) {
    return { token: bot.token, chatId: String(bot.ownerChat), botSlug: slug };
  }
  return null;
}

/** 슬랙 수신 메시지 분류(순수) — 폴 루프가 이 결과대로 행동한다. (export: 회귀 테스트용)
    반환 kind: skip(봇/비텍스트/비사장) · pair(페어링 코드 일치 — 발신자가 사장으로 고정)
    · hint(미페어링 안내) · approval(결재 회신 — 큐를 거치지 않고 즉시) · turn(크루 턴 — 큐 적재) */
export function classifySlackMessage(cfg, m) {
  if (!m?.text || m.bot_id || m.user === cfg.botUserId || m.subtype) return { kind: 'skip' };
  const text = String(m.text).replace(/<@[A-Z0-9]+>\s*/g, '').trim();
  if (!cfg.ownerId) { // 미페어링 — 코드를 보낸 사람만 사장으로 고정(TOFU 차단). 그 전엔 어떤 지시도 실행하지 않는다
    if (cfg.pairCode && text.toUpperCase() === cfg.pairCode) return { kind: 'pair', user: String(m.user) };
    return { kind: 'hint' };
  }
  if (String(m.user) !== String(cfg.ownerId)) return { kind: 'skip' }; // 사장만 — 채널 멤버 전원이 구동·결재하던 구멍 차단
  // 결재 판정은 parseApprovalText 단일 원천 — 인라인 사본이 남으면 한쪽만 고쳐져 승인/거절 오판이 된다
  // (분리 검수 L1 2026-07-28: 이 파일 안에 같은 정규식 사본이 잔존하던 것을 단일화 완성).
  const ap = parseApprovalText(text);
  if (ap) return { kind: 'approval', approve: ap.approve, id: ap.id };
  return { kind: 'turn', text };
}
