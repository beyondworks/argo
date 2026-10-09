// 도움말 — 에이전트와의 1:1 대화: 새 대화·세션, 첨부, 진행·중단·대기열·바로 보내기, 실패·대체·다시 보내기, 긴 대화 요약, 위임 제한, 작업 폴더, 패널, 빨간펜·규칙 제안
export default {
  id: 'chat',
  ko: {
    title: '에이전트와 1:1 대화',
    keywords: ['대화', '채팅', '새 대화', '대화 세션', '첨부', '파일 올리기', '중단', '대기열', '바로 보내기', '다시 보내기', '빨간펜', '위임 제한'],
    body: `사이드바에서 에이전트를 누르면 1:1 대화가 열립니다. 대화는 새로 고침이나 다른 기기에서도 이어집니다.

**보내기와 첨부**
- Enter는 보내기, Shift+Enter는 줄바꿈입니다. 입력창이 비었을 때 ↑로 이전 지시를 불러옵니다.
- /로 시작하면 명령 목록이 열립니다: /new(새 대화)·/card(카드)·/panel(패널)·/memory·/room·/deck, 설치한 스킬, 직접 등록한 별칭.
- 첨부는 클립 단추·붙여넣기·끌어다 놓기로 넣습니다. 파일 하나에 10MB까지, 한 번에 8개까지입니다. 올리는 중에는 보낼 수 없습니다.

**답변 중**
- 진행 카드에 단계(예: 기억을 살피는 중, 명령 실행 중)와 경과 시간이 보입니다. "중단"을 누르거나 "멈춰"·"중지"·"그만"·"stop"만 보내면 멈춥니다.
- 답변 중에도 입력할 수 있습니다. 보낸 글은 "대기 중 n건"으로 쌓였다가 답이 성공하면 차례로 나갑니다. 실패하거나 중단되면 자동 전송이 멈추고 "지금 보내기"를 눌러야 나갑니다. 대기열은 이 기기에만 남습니다.
- 대기열의 "바로 보내기"는 답변을 멈추지 않고 지금 일하는 에이전트에게 말을 끼워 넣습니다. 끼워 넣을 수 없으면 대기열에 남겼다가 답이 끝난 뒤 보냅니다.

**실패했을 때**
- 실패한 지시는 대화에 흐리게 남고, 아래에 이유와 "다시 보내기"가 나옵니다.
- 연결된 러너가 없으면 "AI 연결 열기" 단추가 보입니다.
- 지정 러너를 못 쓰면 다른 연결 러너가 대신 답하고 "…이(가) 대신 답했습니다"로 알립니다.

**새 대화와 대화 세션**
- "새 대화"는 지금 대화를 왼쪽 "대화 세션" 목록에 보관하고 빈 대화를 엽니다. 회사 기억은 그대로라 새 대화에서도 앞 내용을 찾아 씁니다.
- 보관된 대화는 읽기 전용으로 열리고, "이 대화 이어가기"로 다시 활성으로 바꿉니다. 이름 바꾸기·고정·삭제가 됩니다. 삭제는 보관함으로 옮기는 것이며 설정 → 기기·데이터 → 보관함에서 복구합니다.
- 대화가 길어지면 앞부분을 요약해 이어 가고 "앞 대화를 요약해 이어 갑니다" 줄이 남습니다. 60건 이상이면 "새 대화로 아끼기" 안내도 나옵니다.

**입력창 아래 도구**
- 위임 제한 스위치: 기본은 켜짐(한 턴에 동료에게 2회까지). 풀면 더 많이 맡기지만 AI 사용량이 늘 수 있고, 이 대화에만 적용됩니다.
- 폴더 아이콘: 작업 폴더를 고정하면 매 턴 "지금 일할 폴더"로 전달됩니다. 고정은 이 기기에만 남습니다.
- "패널"(위쪽): 작업 탭에서 이 에이전트의 진행 중·최근 작업을, 파일 탭에서 주고받은 첨부를 봅니다.

**고치기와 규칙**
- 답 아래 "빨간펜"으로 고칠 문장을 드래그해 메모를 달고, 최대 8개를 모아 "수정 지시 보내기"로 한 번에 보냅니다.
- 같은 지적이 두 번 반복되면 "회사 규칙으로 기억할까요?"가 뜹니다. "규칙으로 기억"을 누르면 다음부터 따릅니다.
- 답이 기억에 남으면 "기억에 기록됨" 칩이 붙고, 누르면 기억 화면의 그 문서로 갑니다.`,
  },
  en: {
    title: 'One-on-one chat with an agent',
    keywords: ['chat', 'conversation', 'new chat', 'sessions', 'attach', 'upload file', 'stop', 'queue', 'send now', 'resend', 'annotate', 'delegation limit'],
    body: `Click an agent in the sidebar to open a one-on-one chat. The chat continues after a refresh and on other devices.

**Sending and attaching**
- Enter sends, Shift+Enter adds a line. With an empty input, ↑ recalls earlier instructions.
- Typing / opens the command list: /new, /card, /panel, /memory, /room, /deck, your installed skills, and aliases you registered.
- Attach with the clip button, paste, or drag and drop. Up to 10MB per file and 8 files at a time. You cannot send while files are uploading.

**While the agent replies**
- The progress card shows the stage (e.g. checking memory, running a command) and elapsed time. Press "Stop", or send only "stop" (or 멈춰, 중지, 그만), to stop it.
- You can keep typing. Messages pile up as "{n} queued" and go out in order once the reply succeeds. If the reply fails or is stopped, automatic sending pauses until you press "Send now". The queue stays on this device only.
- "Send now" on a queued line slips it to the working agent without stopping the reply. If that is not possible, it stays queued and is sent after the reply.

**When something fails**
- A failed instruction stays in the chat, dimmed, with the reason and "Resend" below it.
- If no runner is connected, an "Open AI connections" button appears.
- If the assigned runner can't be used, another connected runner answers and a note says it "answered instead".

**New chat and sessions**
- "New chat" files the current chat into the "Sessions" list on the left and opens a blank one. Company memory stays, so the new chat can still find earlier context.
- Archived chats open read only; "Continue this conversation" makes one active again. You can rename, pin or delete them. Delete moves a chat to the archive; restore it in Settings → Devices & data → Archive.
- When a chat gets long, the earlier part is summarized and an "Earlier conversation was summarized to continue" line appears. At 60 messages or more you also see a "Save with a fresh chat" hint.

**Tools under the input**
- Delegation limit switch: on by default (up to 2 hand-offs to colleagues per turn). Lifting it allows more but can increase AI usage; it applies to this chat only.
- Folder icon: pin a work folder and it is passed to the agent as "work here now" on every turn. The pin stays on this device only.
- "Panel" (top): the Tasks tab shows this agent's running and recent work; the Files tab lists files exchanged.

**Revisions and rules**
- "Annotate" under a reply: drag over text to fix, add a note, collect up to 8, and send them together with "Send revisions".
- When the same correction comes up twice, you are asked "make it a company rule?". "Remember as rule" makes agents follow it from then on.
- A reply saved to memory gets a "Recorded in memory" chip that opens the document in Memory.`,
  },
};
