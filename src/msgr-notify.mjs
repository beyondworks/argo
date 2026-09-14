// 회사 단위 메신저 알림 목적지 — 메신저에서 시작하지 않은 크루 알림(결재 요청·장시간 작업 완료·동료 쪽지·루틴 결과·위임 결과)을
// 팀 메신저의 한 방으로 보낸다. 저장: company.json.msgr.notify = { orgId, channelId, events }. 루틴은 자기 목적지(#513)가 있으면 그것이 우선.
// 원점 귀속 규칙(메신저에서 시작한 실행은 그 방으로만)은 그대로다 — 이 목적지는 원점이 없는 이벤트에만 쓴다(gateway.mjs pushEvent).
import { CHANNEL_EVENTS } from './channel-events.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 고를 수 있는 이벤트 = 메신저 채널이 받는 종류(channel-events.mjs 정본). */
export const MSGR_NOTIFY_EVENTS = CHANNEL_EVENTS.msgr;

/** 저장 정규화 — null/빈 값은 "끔". 잘못된 id는 던진다(조용히 다른 방으로 가지 않게). 이벤트는 목록 밖 값·중복 제거 후 정렬. */
export function normalizeMsgrNotify(value) {
  if (!value || typeof value !== 'object') return null;
  const { orgId, channelId } = value;
  if (!UUID.test(String(orgId ?? '')) || !UUID.test(String(channelId ?? ''))) throw new Error('msgr_notify_bad_target');
  const events = [...new Set((Array.isArray(value.events) ? value.events : []).filter((e) => MSGR_NOTIFY_EVENTS.includes(e)))].sort();
  return { orgId, channelId, events };
}

/** 이 이벤트가 목적지로 갈 대상인가 — 켜진 종류이고, 원점(메신저 문맥)이 없고, 루틴이면 자기 목적지가 없을 때. */
export function msgrNotifyWants(notify, event) {
  if (!notify || !notify.events.includes(event.type)) return false;
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
      return en ? `[Approval needed] ${one(it.action)}${it.reason ? `\n${body(it.reason)}` : ''}\n(Decide in the Argo app › Approvals)`
        : `[결재 요청] ${one(it.action)}${it.reason ? `\n${body(it.reason)}` : ''}\n(아르고 앱 › 결재에서 처리)`;
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

/** 이벤트의 "발화 크루" — 방에 이 크루 이름으로 올린다. */
export function msgrNotifyCrewSlug(event) {
  return event.type === 'approval' ? event.item?.slug
    : event.type === 'routine' ? event.routine?.agentSlug
    : event.type === 'delegate' ? event.to
    : event.slug;
}

/** 설정 화면용 후보 방 — 이 회사의 크루 중 하나라도 들어갈 수 있는 채널(조직별). 크루별 목록(routine-notifications)의 합집합. */
export async function msgrNotifyOptions(wsId, { session } = {}) {
  const [{ listAgents }, { messengerNotificationChannels }] = await Promise.all([import('./hub.mjs'), import('./routine-notifications.mjs')]);
  const agents = await listAgents(wsId).catch(() => []);
  const seen = new Map();
  for (const a of agents) {
    const rooms = await messengerNotificationChannels(wsId, a.slug, { session }).catch(() => []);
    for (const r of rooms) if (!seen.has(r.channelId)) seen.set(r.channelId, r);
  }
  return [...seen.values()].sort((x, y) => `${x.orgName} ${x.name}`.localeCompare(`${y.orgName} ${y.name}`));
}
