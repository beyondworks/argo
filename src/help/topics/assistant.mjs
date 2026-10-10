// 하트비트(옛 이름 비서, 능동 알림) — 에이전트 카드 → 하트비트 탭. 동작은 src/assistant/*(엔진·설정)와 맞춘다.
export default {
  id: 'assistant',
  ko: {
    title: '하트비트 — 일정을 지켜보다가 먼저 알려 주는 에이전트',
    keywords: ['하트비트', '하트비트 모드', '비서', '비서 모드', '능동 알림', '일정 알림', '아침 정리', '내일 일정 요약', '조용한 시간', '실행 기기', '마지막 일정 확인', '오늘 보낸 일정 알림'],
    body: `하트비트는 정해 둔 에이전트가 일정을 읽기만 하며 지켜보다가, 일정 시작 전과 아침·저녁에 개인 공간 1:1 방(메신저)으로 먼저 알려 주는 기능입니다. 하트비트는 계정마다 한 곳에서만 켤 수 있습니다. 예전에는 '비서'라고 불렀습니다.

켜는 곳
- 에이전트 카드 → 하트비트 탭 → 하트비트 켜기. 다른 에이전트로 바꾸려면 그 에이전트의 하트비트 탭에서 이 에이전트로 바꾸기를 누릅니다(지금 하트비트는 꺼집니다).
- 같은 계정의 다른 회사에서 하트비트를 켜면 이 회사의 하트비트는 꺼집니다.
- 보는 것: 일정(읽기만) · 받는 곳: 개인 공간 1:1 방 · 권한: 알림만.

알림 설정(하트비트 탭)
- 일정 알림: 일정 시작 10·15·30·60분 전 중 하나(기본 30분 전).
- 조용한 시간: 기본 23:00~08:00. 이 시간에는 알리지 않고 모아 두었다가, 끝나는 시각에 아침 정리로 한 번에 보냅니다. 그래서 아침 정리 시각 = 조용한 시간 끝입니다.
- 조용한 시간에도 일정 알림은 보내기: 켜면 조용한 시간에도 일정 시작 전 알림만은 보냅니다(기본 꺼짐).
- 내일 일정 요약: 저녁에 다음 날 일정을 묶어 보냅니다(기본 21:00). 조용한 시간 안에 둘 수 없고, 아침 정리보다 늦어야 합니다.
- 화면은 30분 간격으로 고릅니다.

얼마나 자주 보나(동작 주기)
- 켜져 있으면 실행 기기가 1분마다 차례를 보고, 일정은 15분마다 읽습니다. 조용한 시간에는 쉬었다가 끝난 뒤 첫 확인에서 밤사이 일정을 모아 아침 정리에 넣습니다.
- 실행 기기: 여러 기기에서 쓰면 실행 담당 기기 한 대에서만 돕니다. 상태 칸에 이 기기 / 다른 기기 / 옛 버전 기기 / 지금 실행 중인 기기가 없습니다 중 하나가 보입니다.
- 마지막 일정 확인 · 오늘 보낸 일정 알림 수는 실행 기기에만 기록되어 그 기기에서 볼 수 있습니다.

멈췄을 때 보이는 상태
- 로그인이 필요합니다 — 이 기기에서 회사를 만든 계정으로 로그인해야 일정을 읽습니다.
- 메신저 알림 종류에서 하트비트 알림이 꺼져 있어 보내지 않습니다.
- 다른 회사의 하트비트가 맡고 있습니다 · 실행 기기가 옛 버전 · 일정을 읽지 못했습니다(다음 확인 때 다시) · 알림을 보내지 못해 다시 보내는 중 · 개인 공간 1:1 방을 열 수 없음.
- 하트비트 설정 파일이 이 화면 밖에서 바뀌면 하트비트를 멈춥니다. 하트비트 탭에서 다시 켜면 새로 저장됩니다.

에이전트에게 물어보기·바꾸기
- 주인의 1:1에서 "하트비트 돌고 있어?"처럼 물으면 에이전트가 argo_status(section=assistant)로 지금 상태를 보고 답합니다.
- 회사 주인이 1:1에서 "아침 정리 7시로"처럼 시키면 에이전트가 바로 바꾸고 바뀐 값과 되돌리는 법을 알려 줍니다. 채널·루틴·다른 사람의 요청은 주인 결재 카드로 갑니다.`,
  },
  en: {
    title: 'Heartbeat — an agent that watches your calendar and messages you first',
    keywords: ['heartbeat', 'assistant', 'assistant mode', 'proactive', 'event reminder', 'morning summary', "tomorrow's summary", 'quiet hours', 'running device', 'last calendar check', 'reminders sent today'],
    body: `Heartbeat is a feature where the agent you pick watches your calendar (read only) and messages you first in your personal 1:1 room (Messenger) — before events start, and in the morning and evening. It runs in one company per account. It used to be called the assistant.

Turning it on
- Agent card → Heartbeat tab → Turn on heartbeat. To switch to another agent, open that agent's Heartbeat tab and choose Use this agent instead (the current heartbeat turns off).
- Turning on heartbeat in another company of the same account turns this company's heartbeat off.
- Watches: calendar (read only) · Delivered to: your personal 1:1 room · Permission: notify only.

Notification settings (Heartbeat tab)
- Event reminder: 10, 15, 30, or 60 minutes before an event starts (default 30).
- Quiet hours: default 23:00–08:00. Nothing is sent during them; items are collected and sent as the morning summary when quiet hours end — so the morning summary time is the quiet hours end.
- Still send event reminders during quiet hours: when on, pre-event reminders are still sent during quiet hours (default off).
- Tomorrow's summary: next day's events, sent in the evening (default 21:00). It cannot fall inside quiet hours and must be later than the morning summary.
- The screen offers 30-minute steps.

How often it checks
- When on, the running device checks every minute and reads the calendar every 15 minutes. It rests during quiet hours; the first check afterwards gathers the night's events into the morning summary.
- Running device: with several devices, only the one running device does the work. The status shows This device / Another device / Old-version device / No device is running it right now.
- Last calendar check and reminders sent today are recorded only on the running device and shown there.

Statuses when it stops
- Sign-in needed — sign in on this device with the account that created this company so it can read the calendar.
- Heartbeat notifications are turned off in the messenger notification types.
- Another company's heartbeat is handling this · The running device is on an old version · Couldn't read the calendar (retries next check) · Couldn't send a message (retrying) · Can't open your personal 1:1 room.
- If the heartbeat settings file is changed outside the screen, heartbeat stops. Turning it on again in the Heartbeat tab saves fresh settings.

Asking an agent / changing it
- In the owner's 1:1, ask "Is heartbeat running?" and the agent checks argo_status (section=assistant) before answering.
- If the company owner asks in a 1:1, e.g. "set the morning summary to 7:00", the agent changes it right away and tells you the new value and how to undo it. Requests from channels, routines, or other people go to the owner as an approval card.`,
  },
};
