# 클라우드 동기화와 자격 증명 — 무엇이 올라가고, 열쇠는 어디에 있나

> Argo는 BYOK 제품입니다 — AI 러너(Claude·Codex·Gemini 등)의 API 키·로그인 토큰은 사용자의
> 것입니다. 이 문서는 그 자격 증명이 클라우드로 가는지, 회사 데이터는 어떻게 보호되고 그 한계가
> 무엇인지 사실대로 설명합니다. (최종 갱신 2026-08-29)

**English summary** — If you never sign in, nothing leaves your computer. On the hosted Argo
cloud, your **credentials are not uploaded**: the three credential files — `.secrets.json`
(runner login tokens / API keys), `connections.json` (Telegram/Slack bot tokens), `mcp.json`
(MCP env vars) — are structurally excluded from sync, so newly saved credentials are reachable by
no one but you (operator included); new devices simply reconnect runners and bots. A copy left in
the cloud by an older version is withdrawn on the next sync — except on the free plan, where a
cloud-write restriction defers withdrawal until you are on Pro/trial. Your company **data**
(memory, chats, crew) does still replicate to Argo cloud, encrypted (AES-256-GCM); its envelope
key lives in the same cloud, so for that data the operator can technically decrypt — we do not
claim otherwise. Self-hosting (your own server, your own Supabase) is the one case where
credential sync is offered as a choice, because there "the operator" is you. Cloud workers
(operator-provisioned instances that run your crew for you) are a delegation model still in
design — not covered by this guarantee. Disable all sync with `ARGO_SYNC=0`, or never sign in.

## 자격 증명 (러너 로그인 열쇠) — 호스티드에서는 클라우드로 가지 않습니다

로그인해서 기기 간 동기화가 켜지면 회사 폴더가 Argo 클라우드(Supabase Storage)에 복제됩니다.
그러나 **자격 증명 파일 3종은 이 복제에서 구조적으로 제외됩니다** — 코드가 호스티드 모드를
감지하면 어떤 경로로도 자격을 **새로** 올리지 않습니다(강제는 동기화 함수 내부에 있어 호출
경로와 무관합니다). 과거 버전에서 이미 올라간 사본이 있으면 다음 사이클에 회수합니다(아래
"회수" 참조 — 단 무료 플랜은 회수가 보류됩니다).

| 파일 | 내용 | 호스티드에서 |
|---|---|---|
| `.secrets.json` | 러너 로그인 토큰·API 키 (Claude·Codex·Gemini 등) | 이 기기에만 |
| `connections.json` | 텔레그램·슬랙 봇 토큰 | 이 기기에만 |
| `mcp.json` | MCP 서버 환경변수 (토큰 포함 가능) | 이 기기에만 |

따라서 호스티드 Argo 클라우드에서 **새로 저장되는 자격은 운영자를 포함해 사용자 본인 외에는
아무도 볼 수 없습니다.** 대가는 새 컴퓨터마다 러너·봇을 다시 연결하는 것뿐입니다(로그인 토큰이
그 기기로는 가지 않으므로).

두 가지 예외는 정직하게 밝힙니다. **무료 플랜**은 클라우드 쓰기가 막혀 있어, 과거 버전에서 올라간
사본이 있다면 그 회수가 보류됩니다(다시 Pro·체험이 되는 시점에 회수됩니다). **클라우드 워커**
(운영자가 프로비저닝해 사용자 대신 크루를 돌리는 인스턴스)는 자격 접근이 기능의 전제인 위임
모델이라 이 보장의 범위 밖이며, 별도 설계 트랙(위임 동의)으로 진행 중입니다.

## 회사 데이터 (기억·대화·크루) — 봉투 암호화로 올라가며, 열쇠는 클라우드에 있습니다

> 전환기 안내(2026-09): 봉투 암호화 기본 적용 이후 **새로 동기화되는 파일부터** 암호문입니다. 그 전에 올라간 파일은 서버 일괄 재봉인이 끝날 때까지 평문으로 남아 있을 수 있고, v0.1.24 미만 클라이언트는 업데이트가 필요합니다.

회사 데이터는 여전히 클라우드에 복제됩니다. 노트 제목 등 맥락이 새지 않도록 봉투 암호화
(AES-256-GCM)로 저장되지만, 그 봉투를 여는 계정별 열쇠(`account_keys`)는 같은 Argo 클라우드에
있습니다. 데이터베이스 접근 규칙(RLS)상 다른 사용자는 열쇠를 읽을 수 없지만, 서버 운영자와
서비스 롤 권한은 기술적으로 회사 데이터를 복호화할 수 있습니다 — **이 데이터에 한해서는 "운영자도
절대 볼 수 없다"고 말하지 않습니다.** 회사 데이터까지 사용자만 여는 종단간 암호화(E2EE)는 별도
설계 트랙으로 진행 중입니다.

정리하면: **러너 로그인 열쇠(자격 증명) = 클라우드로 안 감(본인만 보유). 회사 데이터 = 암호화되어
가지만 열쇠는 서버(운영자 복호화 가능).** 사용자가 가장 민감하게 여기는 러너 자격은 첫 번째 범주에
속합니다.

## 회수 (이미 올라가 있던 자격 사본)

과거 버전에서 자격이 클라우드에 올라간 적이 있으면, 동기화가 실제로 도는 상태(Pro·체험)에서
다음 사이클이 그 활성 사본을 무해한 마커로 덮어써 회수합니다(삭제가 아니라 덮어쓰기 — 아직
업데이트를 못 받은 다른 기기가 "파일이 사라졌다 = 삭제됐다"로 오해해 자기 로컬 자격을 지우는
것을 막기 위해서입니다). 실행된 사이클에는
설정 카드에 "자격 회수 N건"이 잠깐 표시될 수 있습니다(짧아서 못 볼 수 있으며, 동기화가 도는
상태라면 표시가 없어도 회수는 진행됩니다 — 무료 플랜의 예외는 바로 아래를 보세요).

**무료 플랜의 한계**: 무료 플랜은 클라우드 쓰기가 서버 정책(RLS)으로 막혀 있어, 이 회수(마커
덮어쓰기)도 실행되지 못하고 보류됩니다. 계정이 다시 Pro·체험이 되면 그 사이클에 회수가
실행됩니다. 즉 "한때 Pro였다가 무료로 내려간" 계정에 과거 사본이 남아 있을 수 있으며, 이 구간의
완전한 회수(무료 상태에서의 즉시 회수)는 서버 정책 변경이 필요한 별도 작업으로 남아 있습니다.
또한 플랫폼 차원의 백업·스냅샷이 존재한다면 그 보존 기간 동안의 과거 사본까지는 이 문서가
보장하지 않습니다.

## 셀프호스트 — 자격 동기화가 선택지인 유일한 경우

셀프호스트(서비스 키 모드)는 사용자의 서버·사용자의 Supabase가 곧 클라우드입니다. 열쇠도
데이터도 사용자 인프라에 있으므로 "운영자"가 곧 사용자 본인이고, 위의 걱정이 적용되지 않습니다.
그래서 셀프호스트에서는 자격 증명을 기기 간에 동기화할지 회사 단위로 **선택**할 수 있습니다
(설정 → 기기 간 동기화 → 자격 증명 동기화). 끄면 호스티드와 동일하게 각 기기에만 저장되고
클라우드 사본은 회수됩니다. [selfhost.md](selfhost.md) 참조.

## 전부 끄기

- **동기화 전체 끄기** — 환경변수 `ARGO_SYNC=0`. 이 기기는 아무것도 올리고 내리지 않습니다.
- **로그인하지 않기** — 처음부터 전부 로컬 전용입니다.
