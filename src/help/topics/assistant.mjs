// 하트비트(옛 이름 비서, 능동 알림) — 관리는 루틴 → 내 하트비트(유건 10/10), 에이전트 카드 → 하트비트 탭은 현황 보기. 동작은 src/assistant/*(엔진·설정)와 맞춘다.
export default {
  id: 'assistant',
  ko: {
    title: '하트비트 — 일정을 지켜보다가 먼저 알려 주는 에이전트',
    keywords: ['하트비트', '내 하트비트', '하트비트 모드', '방해 금지 시간', '하트비트 만들기', '하트비트 일시 정지', '하트비트 끄기', '확인 주기', '비서', '비서 모드', '능동 알림', '일정 알림', '아침 정리', '내일 일정 요약', '조용한 시간', '실행 기기', '마지막 일정 확인', '오늘 보낸 일정 알림'],
    body: `하트비트는 정해 둔 에이전트가 일정을 읽기만 하며 지켜보다가, 일정 시작 전과 아침·저녁에 개인 공간 1:1 방(메신저)으로 먼저 알려 주는 기능입니다. 하트비트는 계정마다 한 곳에서만 켤 수 있습니다. 예전에는 '비서'라고 불렀습니다.

만들고 관리하는 곳 — 루틴 → 내 하트비트
- 사이드바 "루틴" 맨 위의 "내 하트비트"에서 한 화면으로 정합니다: 무엇을 알려 줄까요(일정 · 메일), 언제 알려 줄까요(일정 몇 분 전 · 아침 정리 · 내일 일정 요약), 방해 금지 시간, 얼마나 자주 확인할까요(10·15·30·60분), 누가 알려 줄까요(에이전트). 맨 위 스위치를 켜면 시작합니다.
- 켠 뒤에는 값을 고르면 바로 저장됩니다. 스위치를 끄면 멈추고 설정은 남습니다 — 다시 켜면 그 설정으로 이어서 알려 줍니다.
- 고급(접힘): 메일은 미리 보기만, 받는 곳·권한, 실행 기기, 마지막 메일 확인, 설정 지우기(확인 창을 거쳐 이 회사의 하트비트 설정을 지웁니다 — 다시 쓰려면 처음부터 고릅니다).
- 알릴 일이 있을 때만 알립니다. 확인했는데 알릴 게 없으면 조용히 지나갑니다.
- 하트비트는 계정마다 한 곳에서만 켜집니다. 같은 계정의 다른 회사에서 켜면 이 회사의 하트비트는 꺼집니다. 다른 회사가 맡고 있으면 "지금 하트비트: 회사 · 에이전트"가 보입니다.
- 에이전트 카드 → 하트비트 탭은 보기 전용입니다: 켜짐 여부, 맡은 에이전트, 확인 주기, 알림 설정, 메일 확인, 실행 기기, 마지막 확인, 오늘 보낸 알림 수를 보여 주고, 루틴에서 관리 버튼으로 루틴의 내 하트비트로 갑니다.
- 보는 것: 일정(읽기만), 고르면 메일(읽기만) · 받는 곳: 개인 공간 1:1 방 · 권한: 알림만.

알림 설정(루틴 → 내 하트비트 — 화면에서는 조용한 시간을 "방해 금지 시간", 조용한 시간 끝을 "아침 정리"로 고릅니다)
- 일정 알림: 일정 시작 10·15·30·60분 전 중 하나(기본 30분 전).
- 조용한 시간: 기본 23:00~08:00. 이 시간에는 알리지 않고 모아 두었다가, 끝나는 시각에 아침 정리로 한 번에 보냅니다. 그래서 아침 정리 시각 = 조용한 시간 끝입니다.
- 조용한 시간에도 일정 알림은 보내기: 켜면 조용한 시간에도 일정 시작 전 알림만은 보냅니다(기본 꺼짐).
- 내일 일정 요약: 저녁에 다음 날 일정을 묶어 보냅니다(기본 21:00). 조용한 시간 안에 둘 수 없고, 아침 정리보다 늦어야 합니다.
- 화면은 30분 간격으로 고릅니다.

얼마나 자주 보나(확인 주기)
- 켜져 있으면 실행 기기가 1분마다 차례를 보고, 일정은 확인 주기마다 읽습니다. 확인 주기는 10·15·30·60분 중에서 고르고 기본은 15분입니다(10분보다 짧게는 두지 않습니다). 주기가 길면 방금 만든 일정은 늦게 알 수 있습니다.
- 예전 버전(0.1.100 이하) 기기가 실행 기기이면 그 기기는 확인 주기를 몰라 15분마다 읽습니다.
- 메일은 확인 주기와 따로, 정해진 간격으로 확인합니다. 조용한 시간에는 쉬었다가 끝난 뒤 첫 확인에서 밤사이 일정을 모아 아침 정리에 넣습니다.
- 실행 기기: 여러 기기에서 쓰면 실행 담당 기기 한 대에서만 돕니다. 상태 칸에 이 기기 / 다른 기기 / 옛 버전 기기 / 지금 실행 중인 기기가 없습니다 중 하나가 보입니다.
- 마지막 일정 확인 · 오늘 보낸 일정 알림 수는 실행 기기에만 기록되어 그 기기에서 볼 수 있습니다.

멈췄을 때 보이는 상태
- 로그인이 필요합니다 — 이 기기에서 회사를 만든 계정으로 로그인해야 일정을 읽습니다.
- 메신저 알림 종류에서 하트비트 알림이 꺼져 있어 보내지 않습니다.
- 다른 회사의 하트비트가 맡고 있습니다 · 실행 기기가 옛 버전 · 일정을 읽지 못했습니다(다음 확인 때 다시) · 알림을 보내지 못해 다시 보내는 중 · 개인 공간 1:1 방을 열 수 없음.
- 하트비트 설정 파일이 설정 화면 밖에서 바뀌면 하트비트를 멈춥니다. 루틴 → 내 하트비트에서 다시 만들면 새로 저장됩니다.

에이전트에게 물어보기·바꾸기
- 주인의 1:1에서 "하트비트 돌고 있어?"처럼 물으면 에이전트가 argo_status(section=assistant)로 지금 상태를 보고 답합니다.
- 회사 주인이 1:1에서 "아침 정리 7시로", "확인 주기 30분으로"처럼 시키면 에이전트가 바로 바꾸고 바뀐 값과 되돌리는 법을 알려 줍니다. 채널·루틴·다른 사람의 요청은 주인 결재 카드로 갑니다.`,
  },
  en: {
    title: 'Heartbeat — an agent that watches your calendar and messages you first',
    keywords: ['heartbeat', 'my heartbeat', 'do not disturb', 'create heartbeat', 'pause heartbeat', 'turn off heartbeat', 'check interval', 'assistant', 'assistant mode', 'proactive', 'event reminder', 'morning summary', "tomorrow's summary", 'quiet hours', 'running device', 'last calendar check', 'reminders sent today'],
    body: `Heartbeat is a feature where the agent you pick watches your calendar (read only) and messages you first in your personal 1:1 room (Messenger) — before events start, and in the morning and evening. It runs in one company per account. It used to be called the assistant.

Where to create and manage it — Routines → My heartbeat
- At the top of "Routines" in the sidebar, "My heartbeat" puts everything on one screen: What should it tell you about? (calendar · mail), When should it tell you? (minutes before events · morning summary · tomorrow's summary), Do not disturb, How often should it check? (10, 15, 30, or 60 min), and Who should tell you? (agent). Flip the switch at the top to start.
- Once on, each choice saves right away. Turning the switch off stops it and keeps your settings — turn it back on to continue with them.
- Advanced (folded): mail preview only, where it's delivered and its permission, running device, last mail check, and Delete settings (after a confirmation, deletes this company's heartbeat settings — you set it up from scratch next time).
- It only messages you when there's something to tell. If a check finds nothing, it stays quiet.
- Heartbeat runs in one company per account. Turning it on in another company of the same account turns this one off. If another company has it, you see "Current heartbeat: company · agent".
- Agent card → Heartbeat tab is view-only: it shows whether it's on, the agent, check interval, notification settings, mail check, running device, last check and today's count, and Manage in Routines takes you to My heartbeat.
- Watches: calendar (read only), plus mail if you choose it (read only) · Delivered to: your personal 1:1 room · Permission: notify only.

Notification settings (Routines → My heartbeat — on screen, quiet hours are "Do not disturb" and their end is the "Morning summary")
- Event reminder: 10, 15, 30, or 60 minutes before an event starts (default 30).
- Quiet hours: default 23:00–08:00. Nothing is sent during them; items are collected and sent as the morning summary when quiet hours end — so the morning summary time is the quiet hours end.
- Still send event reminders during quiet hours: when on, pre-event reminders are still sent during quiet hours (default off).
- Tomorrow's summary: next day's events, sent in the evening (default 21:00). It cannot fall inside quiet hours and must be later than the morning summary.
- The screen offers 30-minute steps.

How often it checks (check interval)
- When on, the running device checks every minute and reads the calendar at the check interval: 10, 15, 30, or 60 minutes (default 15; nothing shorter than 10). With a longer interval, events you just added may be noticed later.
- If an older device (0.1.100 or earlier) is the running device, it doesn't know the interval and reads every 15 minutes.
- Mail is checked on its own schedule, separate from the check interval. It rests during quiet hours; the first check afterwards gathers the night's events into the morning summary.
- Running device: with several devices, only the one running device does the work. The status shows This device / Another device / Old-version device / No device is running it right now.
- Last calendar check and reminders sent today are recorded only on the running device and shown there.

Statuses when it stops
- Sign-in needed — sign in on this device with the account that created this company so it can read the calendar.
- Heartbeat notifications are turned off in the messenger notification types.
- Another company's heartbeat is handling this · The running device is on an old version · Couldn't read the calendar (retries next check) · Couldn't send a message (retrying) · Can't open your personal 1:1 room.
- If the heartbeat settings file is changed outside the settings screen, heartbeat stops. Creating it again in Routines → My heartbeat saves fresh settings.

Asking an agent / changing it
- In the owner's 1:1, ask "Is heartbeat running?" and the agent checks argo_status (section=assistant) before answering.
- If the company owner asks in a 1:1, e.g. "set the morning summary to 7:00" or "check every 30 minutes", the agent changes it right away and tells you the new value and how to undo it. Requests from channels, routines, or other people go to the owner as an approval card.`,
  },
};
