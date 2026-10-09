// 도움말 — 설정 화면 지도: 탭(일반·AI 연결·연결·기기·데이터·위험 구역)별 카드가 무엇을 하는지 한 줄씩
export default {
  id: 'settings',
  ko: {
    title: '설정 화면 안내',
    keywords: ['설정', '설정 탭', '일반', 'AI 연결', '연결', '기기·데이터', '위험 구역', '언어', '테마', '표시 배율', '회사 이름', '회사 삭제'],
    body: `설정은 사이드바 맨 아래 "설정"에서 엽니다. 위쪽 탭 5개로 나뉘고, 마지막으로 연 탭이 다시 열립니다.

**일반**
- 회사 정보: 회사 이름을 바꿉니다. 러너가 2개 이상이면 "기본 러너"(에이전트에 러너를 지정하지 않았을 때 먼저 쓰는 러너)도 여기서 고릅니다.
- 제원: 등록번호·사용자·취항일·에이전트 수·기억·엔진(지금 쓸 수 있는 러너)을 보여 줍니다.
- 언어: 화면 언어(한국어/English). 어디서든 ⌘+/(윈도우 Ctrl+/)로 바꿉니다.
- 에이전트 응답 언어: 에이전트가 답·기억을 쓰는 언어. 화면 언어와 별개로 회사마다 정합니다.
- 표시 배율: 70~200%. ⌘+·⌘−·⌘0으로도 조절합니다.
- 풀 오토 모드: 사용자가 직접 시킨 일을 결재 없이 실행합니다(결재 주제 참고).
- 테마: 기본 테마(그래파이트·아르고·리넨)와 모드(시스템·라이트·다크), 또는 "다른 스킨".
- Hermes·OpenClaw 데이터 가져오기: 이 기기의 Hermes·OpenClaw(그리고 Claude·Codex 스킬·도구 설정)에서 고른 항목만 복사합니다.

**AI 연결**
- 러너 연결: 에이전트의 AI 엔진을 API 키·구독·이 컴퓨터 로그인으로 연결합니다(러너 주제 참고).

**연결**
- 알림 받을 메신저: 결재 요청·작업 완료·쪽지·루틴 결과를 받을 곳(아르고 메신저·텔레그램·슬랙)을 체크합니다.
- Argo 메신저 연결: 에이전트를 메신저에 파견하고 메신저 응답 상태를 봅니다. 아래에 Argo 오피스 열기가 있습니다.
- 텔레그램 연결·슬랙 연결: 봇 토큰을 넣고 연결 코드로 내 계정을 고정합니다.
- 외부 서비스 연결: 구글 계정처럼 로그인만으로 붙는 서비스를 연결합니다.

**기기·데이터**
- 다른 기기와 연결: 같은 계정으로 로그인하면 회사가 자동으로 내려옵니다. 셀프호스팅에서는 연결 코드를 만듭니다.
- 앱 업데이트: 현재 버전, 업데이트 확인과 설치.
- 시스템 권한: 데스크톱 앱에서 macOS 파일 권한이나 Windows 랜섬웨어 방지 설정을 여는 단추.
- 터미널에서 argo 쓰기: 터미널 명령 argo를 등록합니다.
- 데이터 내보내기: 이 회사의 대화·기억·에이전트 카드를 고른 폴더로 복사합니다.
- 보관함: 삭제한 대화를 복구하거나 영구 삭제합니다.
- 외부 작업 폴더: 에이전트가 회사 폴더 밖에서 일할 폴더(최대 8개, 이 컴퓨터에만 적용).
- 기기 간 동기화: 요금제, 동기화 상태, 이 기기가 실행 담당인지, 자격 증명 동기화.
- 종단간 암호화: 동기화되는 회사 데이터를 내 기기에서 만든 열쇠로 암호화합니다.
- 옵시디언에서 가져오기: 옵시디언 볼트를 미리보기 후 기억 구조에 맞게 복사합니다. 원본 볼트는 고치지 않습니다.

**위험 구역**
- 회사 삭제: 회사 이름과 "삭제하겠습니다"를 입력해야 실행됩니다. 목록에서 사라지지만 데이터는 바로 지워지지 않고 보존됩니다.
- 삭제한 회사: 삭제한 회사를 되돌립니다. 홈 화면의 "삭제한 회사 n개 · 되돌리기"에서도 됩니다. 다른 기기에서도 삭제했다면 그 기기에서도 되돌립니다.

설정 맨 아래에는 "약관 및 개인정보" 링크가 있습니다.`,
  },
  en: {
    title: 'Settings guide',
    keywords: ['settings', 'settings tabs', 'general', 'AI connection', 'connections', 'devices & data', 'danger zone', 'language', 'theme', 'display zoom', 'company name', 'delete company'],
    body: `Open Settings from "Settings" at the bottom of the sidebar. It has five tabs at the top, and the tab you used last opens again.

**General**
- Company Info: rename the company. With two or more runners connected, "Default runner" (used first when an agent has no runner set) is here too.
- Specifications: Unit, User, Commissioned, Agents, Vault and Engine (runners usable now).
- Language: display language (한국어/English). Toggle anywhere with ⌘+/ (Ctrl+/ on Windows).
- Agent response language: the language agents use for replies and memory, set per company, separate from the display language.
- Display zoom: 70–200%. Also ⌘+, ⌘−, ⌘0.
- Full auto mode: run work you gave directly without approvals (see the approvals topic).
- Theme: base theme (Graphite, Argo, Linen) and mode (System, Light, Dark), or "Other skins".
- Import Hermes & OpenClaw data: copy only the items you pick from Hermes or OpenClaw on this device (Claude and Codex skills and tool settings too).

**AI connection**
- Runner connections: connect the agents' AI engines by API key, subscription or this computer's login (see the runners topic).

**Connections**
- Where to receive agent notifications: check where approval requests, task results, agent mail and routine results go (Argo Messenger, Telegram, Slack).
- Argo Messenger connection: dispatch agents to the messenger and see the messenger response status. "Open Argo Office" is at the bottom.
- Telegram / Slack: add a bot token and lock in your account with the pairing code.
- Connected services: connect services you join just by signing in, such as with Google.

**Devices & data**
- Link another device: signing in with the same account brings the company down automatically. Link codes are for self-hosting.
- App updates: current version, check for updates, install.
- System Permissions: in the desktop app, buttons that open macOS file permissions or Windows ransomware protection.
- Use argo in the terminal: register the argo terminal command.
- Export Data: copy this company's conversations, memory and agent cards to a folder you choose.
- Archive: restore or permanently delete deleted conversations.
- External Work Folders: folders outside the company workspace agents may work in (up to 8, this computer only).
- Cross-device Sync: plan, sync status, whether this device runs the agents, credential sync.
- End-to-end encryption: encrypt synced company data with a key created on your device.
- Import from Obsidian: preview, then copy an Obsidian vault into the memory structure. Your vault is never modified.

**Danger zone**
- Delete Company: requires typing the company name and "delete this". It disappears from the list, but the data is kept rather than erased immediately.
- Deleted companies: restore a deleted company. "{n} deleted · Restore" on the home screen does the same. If you deleted it on another device as well, restore it there too.

At the very bottom of Settings is the "Terms & Privacy" link.`,
  },
};
