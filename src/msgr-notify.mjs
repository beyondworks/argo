// 크루 알림을 아르고 메신저로 — 설정 › 연결 "알림 받을 메신저"의 아르고 메신저 체크(유건 결정 2026-09-15: 방 선택 없음).
// 켜면 메신저에서 시작하지 않은 크루 알림(결재 요청·장시간 작업 완료·동료 쪽지·루틴 결과·위임 결과)이 **그 크루와 나의 1:1 방**으로 간다
// (텔레그램의 크루 봇 DM과 같은 감각). 저장: company.json.msgr.notify = { mode: 'dm' }. 종류별 세부는 company.msgr.mutedEvents(기존 채널 공통 규칙).
// 원점 귀속 규칙(메신저에서 시작한 실행은 그 방으로만)은 그대로 — 원점이 없는 이벤트에만 쓴다(gateway.mjs pushEvent).
import { CHANNEL_EVENTS } from './channel-events.mjs';
import { approvalPlainText, approvalCommandLabel } from './approvals.mjs';

/** 보낼 수 있는 종류 = 메신저 채널이 받는 종류(channel-events.mjs 정본). */
export const MSGR_NOTIFY_EVENTS = CHANNEL_EVENTS.msgr;

/** 저장 정규화 — { mode:'dm' } 만 켜짐. 그 외(null·옛 방 지정 형식 포함)는 끔으로 본다(옛 형식은 조용히 다른 방으로 가지 않게 버린다). */
export function normalizeMsgrNotify(value) {
  return value && typeof value === 'object' && value.mode === 'dm' ? { mode: 'dm' } : null;
}

/** 이 이벤트가 1:1 방으로 갈 대상인가 — 켜져 있고, 메신저가 받는 종류이고, 음소거가 아니고, 루틴이면 자기 목적지(#513)가 없을 때. */
export function msgrNotifyWants(notify, event, mutedEvents = []) {
  if (!notify || notify.mode !== 'dm') return false;
  if (!MSGR_NOTIFY_EVENTS.includes(event.type) || (mutedEvents ?? []).includes(event.type)) return false;
  if (event.type === 'routine' && event.routine?.notifications !== undefined) return false;
  return true;
}

/** 방에 올릴 본문 — 종류별 한 줄 머리 + 크루의 보고. 이름은 호출자가 넣는다(slug 노출 금지). */
export function formatMsgrNotify(event, lang = 'ko', names = {}) {
  const en = lang === 'en';
  const name = (slug) => names[slug] ?? slug ?? '';
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const body = (s) => String(s ?? '').trim();
  switch (event.type) {
    case 'approval': {
      const it = event.item ?? {};
      // 쉬운 문장화(분리 검수 M-3) — plain 있으면 그 문장 + "명령: <action>" 한 줄, 없으면 기존 action/reason.
      const plain = approvalPlainText(it, lang);
      const summary = plain ? `${plain}\n${approvalCommandLabel(lang)}: ${one(it.action)}` : `${one(it.action)}${it.reason ? `\n${body(it.reason)}` : ''}`;
      return en ? `[Approval needed] ${summary}\n(Decide in the Argo app › Approvals)`
        : `[결재 요청] ${summary}\n(아르고 앱 › 결재에서 처리)`;
    }
    case 'job':
      return en ? `[Long task ${event.ok === false ? 'stopped' : 'done'}] ${one(event.title)}\n\n${body(event.reply)}`
        : `[장시간 작업 ${event.ok === false ? '중단' : '완료'}] ${one(event.title)}\n\n${body(event.reply)}`;
    case 'crewmail':
      return en ? `[Crew mail] ${name(event.from)} → ${name(event.slug)}\n\n${body(event.reply)}`
        : `[동료 쪽지] ${name(event.from)} → ${name(event.slug)}\n\n${body(event.reply)}`;
    case 'routine':
      return en ? `[Routine] ${one(event.routine?.title)}${event.ok === false ? ' (failed)' : ''}\n\n${body(event.reply)}`
        : `[루틴] ${one(event.routine?.title)}${event.ok === false ? ' (실패)' : ''}\n\n${body(event.reply)}`;
    case 'delegate':
      return en ? `[Delegation result] ${name(event.from)} → ${name(event.to)}: ${one(event.task)}\n\n${body(event.reply)}`
        : `[위임 결과] ${name(event.from)} → ${name(event.to)}: ${one(event.task)}\n\n${body(event.reply)}`;
    default:
      return '';
  }
}

/** "알림 받을 메신저" 체크박스 상태 정본 — 설정 카드와 라우트가 같은 판정을 쓴다(검수 #537 HIGH-3: hasToken만 보면 '중지'인 채널이 켜짐으로 보인다).
    connected = 실제 배달 조건(텔레그램: 게이트웨이 가동+토큰+chatId 또는 페어링된 크루 직통 봇, 슬랙: 가동+토큰+채널, 아르고 메신저: 로그인+파견 크루).
    on = 체크 표시(텔레그램·슬랙: 연결됨이고 음소거 0개, 아르고 메신저: notify mode dm). on인데 connected가 아니면 해제만 가능하게 두는 것은 카드의 몫. */
export function notifyChannelState({ connections = {}, company = {}, signedIn = false } = {}) {
  const t = connections.telegram ?? {}, s = connections.slack ?? {};
  // 체크박스는 전부/없음만 쓴다 — 옛 칩으로 일부만 음소거해 둔 회사는 '끔'으로 보여 체크 한 번으로 전부 켜게 한다(화면=실제, 검수 2R MEDIUM-2)
  const unmuted = (muted) => !(muted ?? []).length;
  // 직통 봇은 토큰을 붙인 순간 항목이 생기고 페어링(ownerChat) 뒤에야 배달된다 — 배달 정본 telegramBriefingDest의 봇 분기와 같은 조건(검수 2R MEDIUM-1)
  const botOk = (a) => !!(a?.token && a?.ownerChat && (t.ownerId == null || String(a.ownerId) === String(t.ownerId)));
  const tgConnected = !!((t.enabled && t.token && t.chatId) || Object.values(t.agents ?? {}).some(botOk));
  const slackConnected = !!(s.enabled && s.token && s.channel);
  return {
    msgr: { connected: !!signedIn && !!company.msgr?.enabled, on: !!normalizeMsgrNotify(company.msgr?.notify), signedIn: !!signedIn },
    telegram: { connected: tgConnected, on: tgConnected && unmuted(t.mutedEvents) },
    slack: { connected: slackConnected, on: slackConnected && unmuted(s.mutedEvents) },
  };
}

/** 이벤트의 "발화 크루" — 그 크루와 나의 1:1 방에, 그 크루 이름으로 올린다. */
export function msgrNotifyCrewSlug(event) {
  return event.type === 'approval' ? event.item?.slug
    : event.type === 'routine' ? event.routine?.agentSlug
    : event.type === 'delegate' ? event.to
    : event.slug;
}
