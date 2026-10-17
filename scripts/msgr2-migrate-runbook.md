# 메신저 v2 이전·스위치 런북 (U8)

설계 정본: 볼트 `AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md` 6절(이전)·7절 경우 13·25.
함수: `supabase/migrations/20261018050000_msgr2_backfill.sql` · 실행기: `scripts/msgr2-migrate.sh` · 비우기: `scripts/msgr2-migrate-rollback.sql` · 시험: `test/msgr2-backfill-pg.test.mjs`.

**누가·어디서:** 운영 적용과 실행은 맥 one만 한다(`msgr2-migrate.sh`는 맥 two에서 로컬 시험 DB가 아니면 exit 5). qbwr에는 운영 데이터를 복사하지 않는다 — qbwr 연습은 합성 데이터로 한다.

## 0. 전제 (모두 "예"여야 시작한다)

| # | 확인 | 방법 |
|---|---|---|
| 0-1 | 옛 메신저가 중단 상태다(옛 쓰기 거부) | `select value from msgr_settings where key = 'msgr_paused'` 가 있다 |
| 0-2 | U1·U3·U2·U2b·U7·U8 마이그레이션이 main과 같은 파일로 라이브에 적용돼 있다 | `bash scripts/msgr-live-apply.sh <이름>`(이미 기록됨이면 skip) · 라이브 `prosrc`와 저장소 정의 대조 |
| 0-3 | 크루의 `agent_id`가 다 채워져 있다 | `select count(*) from msgr_crews where agent_id is null` = 0. 아니면 `select public.msgr_agents_backfill()` 한 번(옛 표 쓰기 — 10/14 설계에서 승인된 채움 함수, 멱등) |
| 0-4 | v2 `agent.sync`가 옛 에이전트와 다른 id로 먼저 등록하지 않았다 | 함정 1. 백필 1단계가 겹치면 `msgr2_backfill_agent_id_conflict`로 멈춘다 |
| 0-5 | 옛 계정 삭제(`msgr_delete_me`)를 이전 기간 동안 막았다 | 설계 6절 0단계. **이 PR에는 없다**(총괄 결정 대기 — PR 본문 "미룸") |
| 0-6 | 스위치 표지가 없다 | `select count(*) from msgr_settings where key = 'msgr2_switched_at'` = 0 |
| 0-7 | 실행 전 옛 표 행 수를 남겼다 | `bash scripts/msgr2-migrate.sh verify` 출력의 `old_counts`를 파일로(아직 비어 있으면 ok=false가 정상) |

## 1. 백필 (설계 6절 2단계)

```bash
bash scripts/msgr2-migrate.sh status
bash scripts/msgr2-migrate.sh run
```

- 14단계를 순서대로 한 묶음씩 부른다: 에이전트 → 공간 → 공간 멤버 → 파견 → 방 → 방 멤버 → 글(5,000행씩) → 첨부 → 읽음 → 반응 → 방 설정 → 조직 고정 → 대기 결재(expired) → 글 identity.
- 한 묶음 = 한 트랜잭션이고 체크포인트를 같은 트랜잭션에서 쓴다. 터미널이 끊기거나 실패하면 그 묶음만 되돌아간다 — **같은 명령을 다시 실행하면 체크포인트부터** 간다.
- 실행기 두 개를 동시에 띄워도 한 작업은 한 곳만 돈다(`busy`, 5초씩 최대 5분 기다림). `restart`가 끼어들면 돌던 실행기는 `stale_generation`으로 멈춘다.
- 백필 중 방송·푸시·offer는 0이다(서비스 문맥 + 트랜잭션 안의 `msgr2.backfill = on`). 확인: 실행 전후 `select count(*) from net._http_response`·Realtime 대시보드 메시지 수가 그대로.
- 부하: 글 5,000행 묶음 하나가 옛 글 읽기 5,000 + 새 글 쓰기 최대 5,000. 운영 글 수 ÷ 5,000 = 묶음 수. 묶음은 기다림 없이 이어지므로 실행 시간 동안만 쓰기가 몰린다(유휴 쓰기 아님).
- 멈춤 코드: `msgr2_backfill_agent_ids_missing`(0-3) · `msgr2_backfill_agent_id_conflict`(0-4) · `msgr2_backfill_room_without_space`(방 만든 사람의 개인 공간 없음 — 2단계 공간이 끝났는지 확인) · `msgr2_backfill_no_progress`(체크포인트가 안 움직임 — 결함, 멈추고 보고) · `msgr2_backfill_after_switch`.

## 2. 검증 (6절 2단계 확인 칸, 경우 25)

```bash
bash scripts/msgr2-migrate.sh verify
```

ok가 true여야 다음으로 간다. 출력 칸:

| 칸 | 뜻 | 기대 |
|---|---|---|
| `missing.*` | 옛 행 중 새 표에 짝이 없는 수(표마다) | 모두 0 |
| `rooms_mismatch` | 방별 `(id, md5(body))` 묶음 해시가 다른 방 수 | 0 |
| `sample_mismatch` | 무작위 200글의 방·본문·시각·작성자·답글 대조 | 0 |
| `old_counts` | 옛 표 행 수 | 0-7에서 남긴 값과 같다(백필은 옛 표를 읽기만 한다) |

ok면 모든 작업 행에 `verified_at`이 찍힌다.

## 3. 첨부 열기 (맥 one, SQL로 못 하는 칸)

옮긴 첨부 20개를 무작위로 골라 Storage API로 서명 URL을 만들고 실제로 연다.
```sql
select storage_path, room_id from public.msgr2_attachments order by random() limit 20;
```
- `storage_path`는 `msgr/<옛 경로>`다(버킷 + 경로). 조직 첨부(`msgr/<조직>/<채널>/…`)는 공간 id = 조직 id, 방 id = 채널 id라 v2 Storage 정책(U2b `_msgr2_storage_gate`)이 판정한다. 개인 첨부(`msgr/p/<채널>/…`)는 옛 정책이 판정한다(스위치 뒤 판정은 U9에서 정한다 — 미룸).
- 20개 모두 200이어야 한다. 결과(경로 해시·상태 코드)를 발행 기록에 남긴다.
- 옛 정리 작업(`msgr_storage_sweep_list`)은 `msgr2_attachments`가 가리키는 객체를 후보에서 뺀다(U2b). 이전 직후 `select count(*) from public.msgr_storage_sweep_list(1000) s where exists (select 1 from public.msgr2_attachments a where a.storage_path = 'msgr/' || s)` = 0 을 확인한다.

## 4. 스위치 직전 두 번째 실행 (6절 3단계)

```bash
bash scripts/msgr2-migrate.sh restart
bash scripts/msgr2-migrate.sh run
bash scripts/msgr2-migrate.sh verify
```
멱등이라 바뀐 행만 쓴다. 중단 중에 바뀐 것(프로필·탈퇴·제외)만 반영되고 `status`의 `written` 합이 0에 가까워야 한다. 크게 나오면 멈추고 원인을 본다.

## 5. 스위치 (6절 4단계)

1. `insert into msgr_settings (key, value) values ('msgr2_switched_at', now()::text);` — 이 뒤로 백필·비우기는 거부된다.
2. `msgr2_enabled` 켬, 메신저 새 판·본체 약속 판 공개(U9 순서).
3. 옛 방 공지: `select public.msgr_pause_announce('<ko>', '<en>')`.
4. 경우 표 1·4 확인.

## 되돌림

| 언제 | 방법 |
|---|---|
| 스위치 전 | `bash scripts/msgr2-migrate.sh rollback` — 백필 사본만 비우고 작업 행을 처음으로(세대 +1). v2에서 새로 생긴 행(옛 짝 없는 글·방·일·에이전트·팀 공간, 토픽·일 기록·효과·리스·푸시 장부)이 하나라도 있으면 아무것도 지우지 않고 멈춘다. 옛 표는 손대지 않는다 |
| 스위치 후 | 비우지 않는다. v2 중단 스위치(`msgr2_paused`) → 고쳐서 다시 켬 |
| 이 마이그레이션 자체 | 위 비우기 뒤 `scripts/rollback/20261018050000_msgr2_backfill.down.sql`(작업 행에 돈 기록이 있으면 멈춘다) |

## 함정

1. **v2 `agent.sync`가 먼저 돈 경우.** 옵트인 본체가 v2에 붙으면 `msgr2_agents`에 새 id로 등록한다. 같은 (주인, 회사, slug)가 옛 id와 다르면 옛 글의 작성자 연결이 깨지므로 백필이 멈춘다. 처리: 그 v2 행이 가리키는 데이터가 없으면 스위치 전 비우기로 같이 지우고, 데이터가 있으면 총괄에 보고한다.
2. **방 모양은 처음 만들 때 한 번만 정한다.** 두 번째 실행은 이름·보관·기억·에이전트 정책과 멤버만 맞춘다(종류·짝 키는 잠금 열이라 바꾸지 않는다).
3. **제외 목록이 있던 public 방은 private가 된다.** 옛날에는 조직에 새로 들어온 member가 자동으로 보던 방이다. v2에서는 이전 시점의 활동 멤버만 멤버가 되고, 그 뒤에 들어온 사람은 초대해야 본다(넓어지는 쪽을 막고 좁아지는 쪽을 택했다).
4. **결정된 결재·실행 기록·푸시 토큰·초대·리스는 옮기지 않는다**(설계 6절). 새 앱에서 다시 등록·초대한다.
5. 글 identity는 옛·새 글 id 중 큰 값으로 맞춘다. 스위치 뒤 새 글 id는 옛 최댓값 + 1부터다.
