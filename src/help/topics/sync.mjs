// 도움말 — 기기 간 동기화, 다른 기기와 연결, 자격 증명 동기화, 종단간 암호화, 데이터 내보내기, 앱 업데이트, 터미널에서 argo 쓰기
export default {
  id: 'sync',
  ko: {
    title: '동기화 · 다른 기기 · 업데이트 · 터미널',
    keywords: ['동기화', '기기 간 동기화', '다른 기기', '새 컴퓨터', '종단간 암호화', '복구 코드', '데이터 내보내기', '백업', '앱 업데이트', '터미널', 'argo 명령', 'CLI'],
    body: `**기기 간 동기화** (설정 → 기기·데이터 → 기기 간 동기화)
- 로그인하면 회사 폴더(에이전트·대화·기억·루틴)가 클라우드에 복제되어, 어느 컴퓨터에서 열어도 같은 회사가 이어집니다. 여러 기기 동기화는 Pro 기능이며, Free는 "이 기기에만 저장됩니다"로 보입니다.
- 카드에 "가동 중"·"마지막 동기화"와 함께 "이 기기가 실행 담당"인지 보입니다. 메신저·텔레그램 대기와 루틴은 실행 담당 기기에서 돌고, 그 기기가 꺼지면 다른 기기가 이어받습니다.
- 러너 로그인·API 키, 텔레그램·슬랙 봇 토큰, MCP 키 같은 자격 증명은 Argo 클라우드에 올라가지 않고 기기마다 저장됩니다("이 기기에만"). 그래서 새 기기에서는 러너와 봇을 다시 연결합니다. 셀프호스트에서만 "자격 증명 동기화"를 포함·제외로 고를 수 있습니다.
- 외부 작업 폴더, 고정한 작업 폴더, 보내기 대기열도 기기마다 따로입니다.
- 오류가 나면 이유와 할 일이 카드에 보이고 자동으로 다시 시도합니다.

**다른 기기와 연결**
- 새 기기에서 Argo를 열고 같은 계정으로 로그인하면 회사가 자동으로 내려옵니다.
- 로그인 없이(로컬 전용) 만든 회사는 로그인 뒤 홈의 "이 계정에 연결"을 눌러야 동기화가 시작됩니다.
- 셀프호스팅에서는 "연결 코드 만들기"로 만든 코드를 다른 기기 홈의 "다른 기기에서 가져오기"에 붙여넣습니다. 코드는 비밀번호처럼 다룹니다.

**종단간 암호화** (같은 탭, 로그인한 기기에서만)
- 켜면 회사 데이터가 이 기기에서 만든 열쇠로 암호화되어 동기화되고, 서버에는 열쇠가 없습니다. 동기화가 도는 상태(Pro)에서 켤 수 있습니다.
- 켤 때 복구 코드가 한 번만 표시됩니다. 안전한 곳에 보관하세요. 모든 기기를 잃으면 복구 코드 없이는 클라우드의 기억을 되찾을 수 없습니다.
- 켜기 전 이 계정의 모든 컴퓨터를 최신 버전으로 업데이트합니다.
- 새 기기는 "이 기기 열쇠 대기"가 됩니다. 열쇠가 있는 기기의 설정에서 지문이 같은지 눈으로 대조한 뒤 "승인"하거나, 새 기기에서 "복구 코드로 열기"를 씁니다.
- 잃어버린 기기는 "제거"와 함께 그 기기의 로그인 세션도 끊으세요(비밀번호 변경·기기 로그아웃).

**데이터 내보내기**
- "데이터 내보내기": 이 회사의 대화·기억·에이전트 카드를 고른 폴더로 복사합니다. 러너 키·봇 토큰 같은 자격 파일은 빼고, 앱은 원래 데이터를 계속 씁니다.
- "클라우드 자료 내보내기": 클라우드에 보존된 회사 자료를 결제 없이 문서 폴더로 내려받습니다.

**앱 업데이트**
- 새 버전이 있으면 상단바에 "업데이트"가 뜨고, 누르면 설치 후 재시작합니다. 설정 → 기기·데이터 → 앱 업데이트에서 "업데이트 확인"도 됩니다.
- 맥에서는 Argo가 '응용 프로그램' 폴더에 있어야 업데이트됩니다. 설치 파일 창이나 외장 디스크에서 실행 중이면 옮기는 방법이 안내됩니다.
- 업데이트 뒤에는 상단바 "새 소식"을 눌러 바뀐 점을 봅니다.

**터미널에서 argo 쓰기** (데스크톱 앱, 같은 탭)
- 카드에서 등록하면(맥은 필요하면 "PATH에 추가", 윈도우는 설치 때 자동) 새 터미널에서 argo로 앱과 같은 회사·에이전트·대화를 씁니다.
- argo는 대화 화면, argo chat 에이전트 "지시"는 한 번 실행, argo login·argo status도 있습니다. 대화 화면에서는 /agent·/new·/hire·/ai·/help·/quit를 씁니다.`,
  },
  en: {
    title: 'Sync, other devices, updates and the terminal',
    keywords: ['sync', 'cross-device sync', 'another device', 'new computer', 'end-to-end encryption', 'recovery code', 'export data', 'backup', 'app update', 'terminal', 'argo command', 'CLI'],
    body: `**Cross-device Sync** (Settings → Devices & data → Cross-device Sync)
- When signed in, the company folder (agents, chats, memory, routines) replicates to the cloud, so the same company continues on any computer. Multi-device sync is a Pro feature; on Free it shows "Stored on this device only".
- The card shows "Active", "Last sync", and whether this device runs the agents. Messenger and Telegram listening and routines run on that device; if it goes off, another device takes over.
- Credentials such as runner logins and API keys, Telegram/Slack bot tokens and MCP keys are not uploaded to Argo cloud; they stay on each device ("This device only"). So on a new device you reconnect runners and bots. Only self-hosting lets you include or exclude "Credential sync".
- External work folders, pinned work folders and send queues are also per device.
- If something goes wrong, the card shows the reason and what to do, and it retries automatically.

**Linking another device**
- Open Argo on the new device and sign in with the same account; the company arrives automatically.
- Companies made without signing in (local-only) start syncing only after you sign in and press "Attach to this account" on the home screen.
- On self-hosting, use "Create link code" and paste the code into "Bring from another device" on the other device's home screen. Treat the code like a password.

**End-to-end encryption** (same tab, signed-in devices only)
- When on, company data syncs encrypted with a key created on this device, and the server never holds the key. It can be turned on while sync is active (Pro).
- A recovery code is shown once when you turn it on. Keep it safe: if you lose every device, cloud memories cannot be recovered without it.
- Update every computer on this account to the latest version before turning it on.
- A new device shows "Awaiting key on this device". On a device that has the key, compare the fingerprints by eye and "Approve", or use "Unlock with recovery code" on the new device.
- For a lost device, "Remove" it and also revoke its login session (change password / sign out devices).

**Exporting data**
- "Export Data": copy this company's conversations, memory and agent cards to a folder you choose. Credential files such as runner keys and bot tokens are left out, and the app keeps using the original data.
- "Export Cloud Data": download the company data kept in the cloud to your Documents folder, with no payment needed.

**App updates**
- When a new version exists, "Update" appears in the top bar; clicking it installs and restarts. You can also "Check for updates" in Settings → Devices & data → App updates.
- On a Mac, Argo must be in the Applications folder to update. If it runs from the installer window or an external drive, you are shown how to move it.
- After an update, click "What's new" in the top bar to see the changes.

**Use argo in the terminal** (desktop app, same tab)
- Register it on the card (on a Mac, "Add to PATH" if needed; on Windows the installer does it), then type argo in a new terminal to use the same companies, agents and chats as the app.
- argo opens the chat screen, argo chat agent "instruction" runs once, and there are argo login and argo status. In the chat screen use /agent, /new, /hire, /ai, /help and /quit.`,
  },
};
