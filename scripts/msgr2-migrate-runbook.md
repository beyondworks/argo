# 메신저 v2 이전·스위치 런북 (U8)

설계 정본: 볼트 `AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md` 6절(이전)·7절 경우 13·25.
함수: `supabase/migrations/20261018050000_msgr2_backfill.sql`·`20261018051000_msgr2_personal_files.sql`·`20261018052000_msgr2_migration_window.sql` · 실행기: `scripts/msgr2-migrate.sh` · 비우기: `scripts/msgr2-migrate-rollback.sql` · 시험: `test/msgr2-backfill-pg.test.mjs`·`test/msgr2-migration-window-pg.test.mjs`.

**한 작업 창으로 묶는다(재검수 5번 결정, 2026-10-18).** 백필이 끝나면 옛 앱(v2 기기 행이 없는 세션)은 조직·개인 첨부를 못 연다 — v2 방 경로의 Storage 판정이 v2만 따르기 때문이다(실측: 백필 전 1 → 뒤 0). 그래서 아래 1~6단계는 **창 열기 → 백필 → 검증 → 첨부 확인 → 바로 스위치 → 창 닫기**를 끊지 않고 한 번에 한다. 백필만 먼저 해 두고 스위치를 미루지 않는다(그 사이 옛 앱 사용자는 첨부를 못 연다). 연습은 qbwr 합성 데이터로 미리 한다.

**누가·어디서:** 운영 적용과 실행은 맥 one만 한다(`msgr2-migrate.sh`는 맥 two에서 로컬 시험 DB가 아니면 exit 5). qbwr에는 운영 데이터를 복사하지 않는다 — qbwr 연습은 합성 데이터로 한다.

## 0. 전제 (모두 "예"여야 시작한다)

| # | 확인 | 방법 |
|---|---|---|
| 0-1 | 옛 메신저가 중단 상태다(옛 쓰기 거부) | `select value from msgr_settings where key = 'msgr_paused'` 가 있다 |
| 0-2 | U1·U3·U2·U2b·U6b·U7·U6d·U8(050000·051000·052000) 마이그레이션이 main과 같은 파일로 라이브에 적용돼 있다 | `bash scripts/msgr-live-apply.sh <이름>`(이미 기록됨이면 skip) · 라이브 `prosrc`와 저장소 정의 대조 |
| 0-3 | 크루의 `agent_id`가 다 채워져 있다 | `select count(*) from msgr_crews where agent_id is null` = 0. 아니면 `select public.msgr_agents_backfill()` 한 번(옛 표 쓰기 — 10/14 설계에서 승인된 채움 함수, 멱등) |
| 0-4 | v2 `agent.sync`가 옛 에이전트와 다른 id로 먼저 등록하지 않았다 | 함정 1. 백필 1단계가 겹치면 `msgr2_backfill_agent_id_conflict`로 멈춘다 |
| 0-5 | 이전 작업 창 표지가 꺼져 있다(아직 열지 않았다) | `select count(*) from msgr_settings where key = 'msgr2_migration_window'` = 0. 1단계에서 연다 |
| 0-6 | 스위치 표지가 없다 | `select count(*) from msgr_settings where key in ('msgr2_switched_at', 'msgr2_enabled')` = 0 (둘 중 하나라도 있으면 백필·비우기가 거부된다) |
| 0-7 | 실행 전 옛 표 행 수를 남겼다 | `bash scripts/msgr2-migrate.sh verify` 출력의 `old_counts`를 파일로(아직 비어 있으면 ok=false가 정상) |
| 0-8 | 옛 앱 사용자 안내를 올릴 준비가 됐다 | 아래 "안내 문구 초안"(창을 열 때 랜딩·공지, 스위치 뒤 옛 방 공지) |
| 0-9 | 작업 창 길이를 잡았다 | qbwr 연습의 전체 시간 + 여유. 창 동안 계정 삭제·보관 조직 영구 삭제가 거부된다 |
| 0-10 | A+ lite가 꺼져 있다(옛 대화를 옮기기로 다시 정한 경우에만 이 문서를 쓴다) | `select coalesce((select value from msgr_settings where key = 'msgr2_lite'), 'on')` = `off`. 켜져 있으면(A+ 기본, 2026-10-19 유건 "옛 대화는 옮기지 않음") 백필 함수가 `msgr2_backfill_lite`로 거부한다(20261019160000) |

## 1. 작업 창 열기 (설계 6절 0단계)

```sql
insert into public.msgr_settings (key, value) values ('msgr2_migration_window', now()::text);
```
- 이 표지가 있는 동안 옛 `msgr_delete_me()`(계정 삭제)·`msgr_purge_orgs()`(보관 조직 영구 삭제)가 `msgr2_migration_in_progress`로 거부된다. 옛 핵심 표(`msgr_messages`·`msgr_channels`·`msgr_channel_members`·`msgr_attachments`·`msgr_reactions`)의 수정·지우기도 사람 문맥에서 같은 코드로 거부된다(서비스 문맥은 통과). 백필이 읽는 원본(옛 표)의 행이 이전 도중 바뀌거나 사라지지 않게 한다. 표지가 없으면 지금과 같은 동작이다.
- 막지 않는 것: 옛 읽음·방 설정·프로필 쓰기(옛 중단 스위치 `msgr_paused`는 INSERT만 막는다 — 20261016170000). 이것들은 5단계 직전 다시 실행(멱등)이 마지막 값으로 맞춘다.
- **창을 열기 전에 지운 방·글은 이전 대상이 아니다**(옛 표에 없으므로 — 옛 동작과 같다).
- 창을 연 시각을 기록에 남긴다. 안내 문구 ①을 올린다.

## 2. 백필 (설계 6절 2단계)

```bash
bash scripts/msgr2-migrate.sh status
bash scripts/msgr2-migrate.sh run
```

- 15단계를 순서대로 한 묶음씩 부른다: 에이전트 → 공간 → 공간 멤버 → 파견 → 방 → 방 멤버 → 글 키(같은 채널의 겹치는 client_msg_id를 한 번 모음) → 글(5,000행씩) → 첨부 → 읽음 → 반응 → 방 설정 → 조직 고정 → 대기 결재(expired) → 글 identity.
- 1:1 짝 키는 U6d(`20261018040000_msgr2_rooms.sql`)와 같다: 개인 친구 1:1 = `p:<작은>:<큰>`, 팀 1:1 = `<작은>:<큰>`, 에이전트 1:1 = 짝 없는 private 방. U6d와 U8을 함께 적용한 결합 시험으로 목록·열기가 옮긴 방을 찾는 것을 확인했다(#1084 PR 본문).
- 한 묶음 = 한 트랜잭션이고 체크포인트를 같은 트랜잭션에서 쓴다. 터미널이 끊기거나 실패하면 그 묶음만 되돌아간다 — **같은 명령을 다시 실행하면 체크포인트부터** 간다.
- 실행기 두 개를 동시에 띄워도 한 작업은 한 곳만 돈다(`busy`, 5초씩 최대 5분 기다림). `restart`가 끼어들면 돌던 실행기는 `stale_generation`으로 멈춘다.
- 백필 중 방송·푸시·offer는 0이다(서비스 문맥 + 트랜잭션 안의 `msgr2.backfill = on`). 확인: 실행 전후 `select count(*) from net._http_response`·Realtime 대시보드 메시지 수가 그대로.
- 부하: 글 5,000행 묶음 하나가 옛 글 읽기 5,000 + 새 글 쓰기 최대 5,000(맥 two 측정: 10만 글 채널에서 묶음 하나 최대 0.18초, 글 키 단계 0.07초). 운영 글 수 ÷ 5,000 = 묶음 수. 묶음은 기다림 없이 이어지므로 실행 시간 동안만 쓰기가 몰린다(유휴 쓰기 아님).
- 멈춤 코드: `msgr2_backfill_agent_ids_missing`(0-3) · `msgr2_backfill_agent_id_conflict`(0-4) · `msgr2_backfill_room_without_space`(방 만든 사람의 개인 공간 없음 — 2단계 공간이 끝났는지 확인) · `msgr2_backfill_no_progress`(체크포인트가 안 움직임 — 결함, 멈추고 보고) · `msgr2_backfill_message_id_conflict`(옛 글 id가 다른 방의 v2 글로 이미 있음 — 덮지 않고 멈춘다, 보고) · `msgr2_backfill_after_switch`.

## 3. 검증 (6절 2단계 확인 칸, 경우 25)

```bash
bash scripts/msgr2-migrate.sh verify
```

ok가 true여야 다음으로 간다. ok가 아니면 원인을 고친 뒤 `restart` → `run` → `verify`를 창 안에서 다시 돌리고(멱등 — 바뀐 행만 쓴다), 창 안에서 못 고치면 "되돌림(스위치 전)"으로 비우고 창을 닫는다. 출력 칸:

| 칸 | 뜻 | 기대 |
|---|---|---|
| `missing.*` | 옛 행 중 새 표에 짝이 없는 수(표마다) | 모두 0 |
| `rooms_mismatch` | 방별 `(id, md5(body))` 묶음 해시가 다른 방 수 | 0 |
| `sample_mismatch` | 무작위 200글의 방·본문·시각·작성자·답글 대조 | 0 |
| `old_counts` | 옛 표 행 수 | 0-7에서 남긴 값과 같다(백필은 옛 표를 읽기만 한다) |

ok면 모든 작업 행에 `verified_at`이 찍힌다.

## 4. 첨부 열기 (맥 one, SQL로 못 하는 칸)

옮긴 첨부 20개를 무작위로 골라 Storage API로 서명 URL을 만들고 실제로 연다.
```sql
select storage_path, room_id from public.msgr2_attachments order by random() limit 20;
```
- `storage_path`는 `msgr/<옛 경로>`다(버킷 + 경로). 조직 첨부(`msgr/<조직>/<채널>/…`)는 공간 id = 조직 id, 방 id = 채널 id라 v2 Storage 정책(U2b `_msgr2_storage_gate`)이 판정한다. 개인 첨부(`msgr/p/<채널>/…`)는 `20261018051000_msgr2_personal_files.sql`이 `p/<방>/…`을 이전된 개인 방(같은 id)으로 해석해 v2 판정으로 연다(읽기 전용 — v2는 `p/` 경로에 쓰지 않는다).
- 표본 20개에 조직 첨부와 개인 첨부를 둘 다 넣고, 각각 그 방 멤버의 v2 세션으로 서명 URL을 만들어 연다. 방 밖 사람 세션으로는 서명이 거부되는지 1개씩 확인한다.
- 20개 모두 200이어야 한다. 결과(경로 해시·상태 코드)를 발행 기록에 남긴다.
- 옛 정리 작업(`msgr_storage_sweep_list`)은 `msgr2_attachments`가 가리키는 객체를 후보에서 뺀다(U2b). 이전 직후 `select count(*) from public.msgr_storage_sweep_list(1000) s where exists (select 1 from public.msgr2_attachments a where a.storage_path = 'msgr/' || s)` = 0 을 확인한다.

## 4b. 스위치 바로 앞 다시 실행 (6절 3단계, 멱등)

```bash
bash scripts/msgr2-migrate.sh restart
bash scripts/msgr2-migrate.sh run
bash scripts/msgr2-migrate.sh verify
```
- 창 표지가 옛 핵심 표의 수정·지우기를 막지만, 옛 읽음·방 설정·프로필은 창 안에서도 바뀔 수 있다(옛 중단 스위치는 INSERT만 막는다). 1~4단계 사이에 바뀐 값을 마지막으로 맞춘다. 멱등이라 바뀐 행만 쓴다 — `status`의 `written` 합이 0에 가까워야 하고, 크게 나오면 멈추고 원인을 본다.
- verify가 ok면 바로 5단계로 간다(사이를 두지 않는다).

## 5. 바로 스위치 (6절 4단계 — 검증·첨부 확인이 끝나면 기다리지 않는다)

1. `insert into msgr_settings (key, value) values ('msgr2_switched_at', now()::text);` — 이 뒤로 백필·비우기는 거부된다.
2. `msgr2_enabled` 켬, 메신저 새 판·본체 약속 판 공개(U9 순서).
3. 옛 방 공지: `select public.msgr_pause_announce('<ko>', '<en>')` — 안내 문구 ②.
4. 경우 표 1·4 확인.

## 6. 작업 창 닫기 (스위치 직후)

```sql
delete from public.msgr_settings where key = 'msgr2_migration_window';
```
- 계정 삭제·보관 조직 영구 삭제·옛 표 수정이 다시 열린다. 닫은 시각을 기록에 남긴다.
- 보관 조직 영구 삭제(`msgr_purge_orgs`)를 부르는 라이브 크론이 있는지는 저장소에서 근거를 찾지 못했다 — **맥 one이 적용 전에 `select jobname, schedule, command from cron.job where command ilike '%msgr_purge_orgs%'`로 확인**하고, 있으면 창 동안 그 실행은 거부(오류 기록)되고 다음 실행이 처리한다는 점을, 없으면 미뤄진 정리를 손으로 한 번 부를지 기록에 남긴다.
- 창을 닫지 않고 두면 사용자가 계정을 지울 수 없다 — 스위치가 늦어지면 창부터 닫지 말고 원인을 본다(되돌림 뒤에는 바로 닫는다).

## 안내 문구 초안 (총괄·유건 확인 뒤 확정)

① 작업 창을 열 때(랜딩 Coming soon·옛 앱 공지 — 한국어 / English)
- 메신저를 새 버전으로 옮기는 작업을 하고 있습니다. 작업하는 동안 옛 메신저 앱에서는 첨부 파일이 열리지 않을 수 있고, 글 고치기·지우기와 계정 삭제도 잠시 막힙니다. 새 버전이 나오면 같은 대화와 첨부를 그대로 볼 수 있습니다. Argo 0.1.113 이후를 쓰셨다면, 메신저 대화와 첨부 사본이 이 기기의 Argo 보관 폴더에 있습니다(Argo 설정 › 연결 › 메신저 기록 옮기기 › 위치).
- We're moving Messenger to a new version. While this runs, attachments may not open in the old Messenger app, and editing or deleting messages and deleting your account are briefly paused. When the new version is out, you'll see the same conversations and attachments. If you used Argo 0.1.113 or later, copies of your Messenger conversations and attachments are in this device's Argo archive folder (Argo Settings › Connections › Messenger history › Location).

② 스위치 뒤 옛 방 공지(`msgr_pause_announce`)
- 메신저가 새 버전으로 옮겨졌습니다. 업데이트하면 이 대화를 다시 이어서 쓸 수 있습니다. 옛 앱에서는 첨부 파일이 열리지 않습니다 — 새 버전이나 Argo 보관 폴더(0.1.113 이후)에서 여세요.
- Messenger has moved to a new version. Update to continue this conversation. Attachments no longer open in the old app — open them in the new version or in your Argo archive folder (0.1.113 or later).

확정 전에 확인할 것: 메뉴 이름은 사전 문구 `settings.msgrArchive.title`('메신저 기록 옮기기' / 'Messenger history')·`settings.msgrArchive.where`('위치' / 'Location')에 맞췄다. 그 위 단계('연결')는 화면에서 한 번 더 확인하고, 보관이 `partial`로 끝난 사람(받지 못한 첨부가 있는 사람)은 창 뒤에 옛 경로로 다시 받을 수 없다는 점을 FAQ에 한 줄 넣을지 정한다(함정 6).

## 되돌림

| 언제 | 방법 |
|---|---|
| 스위치 전 | `bash scripts/msgr2-migrate.sh rollback` — 백필 사본만 비우고 작업 행을 처음으로(세대 +1). v2에서 새로 생긴 행(옛 짝 없는 글·방·일·에이전트·팀 공간, 토픽·일 기록·효과·리스·푸시 장부)이 하나라도 있으면 아무것도 지우지 않고 멈춘다. 옛 표는 손대지 않는다 |
| 스위치 후 | 비우지 않는다. v2 중단 스위치(`msgr2_paused`) → 고쳐서 다시 켬 |
| 이 마이그레이션 자체 | 위 비우기 뒤 `scripts/rollback/20261018050000_msgr2_backfill.down.sql`(작업 행에 돈 기록이 있으면 멈춘다) |
| 작업 창 막기(052000) | 창을 닫은 뒤(표지 삭제) `scripts/rollback/20261018052000_msgr2_migration_window.down.sql` — 표지가 남아 있으면 멈춘다. 감싸개를 지우고 원래 함수를 원래 이름·권한으로 되돌린다 |
| 스위치 전 되돌림을 했을 때 | 비우기 뒤 바로 창을 닫는다(6단계) — 옛 앱 첨부는 다시 열린다(v2 방이 없으면 옛 정책이 판정) |

## 함정

1. **v2 `agent.sync`가 먼저 돈 경우.** 옵트인 본체가 v2에 붙으면 `msgr2_agents`에 새 id로 등록한다. 같은 (주인, 회사, slug)가 옛 id와 다르면 옛 글의 작성자 연결이 깨지므로 백필이 멈춘다. 처리: 그 v2 행이 가리키는 데이터가 없으면 스위치 전 비우기로 같이 지우고, 데이터가 있으면 총괄에 보고한다.
2. **방 모양은 처음 만들 때 한 번만 정한다.** 두 번째 실행은 이름·보관·기억·에이전트 정책과 멤버만 맞춘다(종류·짝 키는 잠금 열이라 바꾸지 않는다).
3. **제외 목록이 있던 public 방은 private가 된다.** 옛날에는 조직에 새로 들어온 member가 자동으로 보던 방이다. v2에서는 이전 시점의 활동 멤버만 멤버가 되고, 그 뒤에 들어온 사람은 초대해야 본다(넓어지는 쪽을 막고 좁아지는 쪽을 택했다).
4. **결정된 결재·실행 기록·푸시 토큰·초대·리스는 옮기지 않는다**(설계 6절). 새 앱에서 다시 등록·초대한다. 채널 topic, 방 설정 pin_pos·folder·sort_pos, 멤버 department·title도 이번에는 옮기지 않는다(옛 표에 남는다).
5. 글 identity는 옛·새 글 id 중 큰 값으로 맞춘다. 스위치 뒤 새 글 id는 옛 최댓값 + 1부터다.
6. **보관 폴더 받기(0.1.113)도 옛 세션으로 첨부를 받는다.** 백필 뒤에는 v2 판정이 막으므로, 그때까지 다 못 받은 첨부(`partial`)는 다시 받을 수 없다. 새 버전에서는 같은 첨부를 그대로 연다(파일은 옮기지 않았다). 창을 열기 전에 보관 받기를 멈출 필요는 없다(실패는 다시 받기 예산 안에서 끝난다).
7. **창 표지는 손으로 넣고 지운다.** 넣는 사람과 지우는 사람이 같은 기록에 시각을 남긴다. 표지가 남은 채 작업이 끝나면 계정 삭제가 계속 막힌다(0-5·6단계).

## 미룸 — R5 로컬 실전 시험(2026-10-20)에서 나온 것

| 구분 | 내용 | 고칠 방향 |
|---|---|---|
| **열기 전 필수 → #1124에서 고침**(files_expected + msgr2_message_ready, 기한 120초 폴백) | 사람 글의 첫 첨부가 본체 턴에 실리지 않는다. 앱 기계는 글 넣기 → `msgr2_attachment_add` → Storage 업로드 순서인데, 서버는 글을 넣는 순간 offer를 만들고 본체는 약 20ms 뒤 accept한다(실측 순서: 글·offer → 첨부 행 → accept → 업로드). A+ 앱에는 첨부가 없어 지금은 막지 않는다 | 실제 빈칸은 "첨부 행은 있는데 Storage 객체가 아직 없음"이다(#1122 검수). 후보 ① 서버 한 곳: 앱이 글 `meta.files = n`을 싣고, 사람 글 트리거는 n>0이면 offer를 마지막 첨부 객체가 생긴 뒤로 미룬다(기한을 넘기면 첨부 없이) ② 본체가 첨부 객체가 생길 때까지 잠깐 기다린 뒤 받는다(상한을 두고) |
| 막지 않음 | 무료 계정 본체가 첫 부팅에서 `pro_required`를 받으면 `createAgentLinkHost` boot가 멈춘 링크(null)에 `start()`를 불러 "boot failed TypeError" 로그 1줄이 남는다(요청 추가 없음) | boot에서 `resync` 뒤 `link`가 null이면 돌아간다 |
| 막지 않음 | 진행 방송(`supabaseTransport.broadcast`)이 구독 전 채널에 `send`해 supabase-js가 REST로 대신 보내며 경고를 낸다(동작함) | `httpSend` 또는 구독 뒤 보내기 |
| 막지 않음(총괄 수용, 2026-10-20) | 사람 채팅의 private 방·1:1 글은 Realtime 방송을 사람마다 1행 쓴다(방 인원 상한 50에 비례). 부하 시험 하루 26,175행(한 달 약 80만, Pro 포함량 월 500만 메시지 안) | 방 토픽(v2:r:<방>) + 앱의 방별 구독으로 글당 1행(상수)으로 — 구독 수가 방 수만큼 늘어나는 것과 함께 검토 |
