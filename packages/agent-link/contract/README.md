# 본체↔메신저 약속 v1 (agent-link contract)

본체(Argo 데스크톱·상주)와 메신저 서버가 에이전트 일을 주고받는 약속이다. 설계 정본은 볼트 `AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md` 2절(D5)이고, 이 폴더는 그 약속을 코드로 고정한 것이다.

| 파일 | 무엇 |
|---|---|
| `v1.mjs` | 정본. 봉투 검사(`validateEnvelope`), type·방향·data 모양, 상태 전이(`nextState`·`effectiveState`), 거부 코드, 버전 협상(`negotiate`), 등급 판정(`tierAllows`). 의존성 없음, Node·브라우저 공용 |
| `schema.mjs` → `schema/envelope.v1.schema.json` | `v1.mjs`에서 만든 JSON Schema(2020-12). 서버 SQL·다른 언어 쪽 참고용. 다시 만들기: `node packages/agent-link/contract/schema.mjs --write` |
| `examples/valid/*.json` | 정상 봉투(type마다 하나 이상, 모르는 필드가 섞인 예 포함) |
| `examples/invalid/<코드>--<무엇>.json` | 거부 봉투. 파일 이름 앞부분이 기대 거부 코드다 |
| `test/contract.test.mjs` | 계약 시험. 루트 `npm test`가 `test/agent-link-contract.test.mjs`를 거쳐 돌린다 |

이 폴더를 쓰는 곳: 본체 부품(`packages/agent-link`, U4), 메신저 연결(`apps/messenger/src/link`, U5), 서버 함수 `msgr2_link_send`·`msgr2_link_pending` 시험(U2).

## 봉투

```json
{ "v": 1, "id": "uuid", "work": "uuid|null", "seq": 3, "type": "work.result",
  "agent": "agent-uuid", "device": "device-uuid", "at": "2026-10-17T09:00:00Z", "data": {} }
```

| 필드 | 뜻 |
|---|---|
| `v` | 약속 버전(정수). 받는 쪽 범위 밖이면 `link_version_unsupported` |
| `id` | 봉투 id. 같은 봉투를 다시 보낼 때도 같은 값 |
| `work` | 일 id. `agent.sync`만 `null` |
| `seq` | (work, 보낸 쪽)마다 늘어나는 정수. 빈 번호는 괜찮다(저장하지 않는 progress도 번호를 쓴다). 같은 (work, 보낸 쪽, seq)로 같은 봉투를 다시 보내면 성공으로 답하고, 다른 봉투면 `seq_conflict`. `work`가 null인 봉투는 `id`로만 중복을 본다 |
| `agent` | 일을 맡은 에이전트(`msgr2_agents.id`). `agent.sync`는 `null`일 수 있다 |
| `device` | 본체가 보낼 때는 보낸 기기, 서버가 보낼 때는 받을 기기. 리스가 없는 offer는 `null`(주인의 runner 기기 아무나) |
| `at` | 보낸 시각, ISO 8601(`Z` 또는 `+09:00`) |
| `data` | type별 내용(아래) |

크기 상한: 봉투 JSON 128KB(`too_large`), offer `context[]` 16KB. 이 둘은 JSON Schema로 적을 수 없어 `v1.mjs`만 검사한다.

## type 10종

| type | 방향·길 | data(필수) | 선택 |
|---|---|---|---|
| `work.offer` | 서버→본체, `w:<uid>` 방송·따라잡기 | `room`, `topic`, `from{kind:user·agent, id}`, `text`(≤20,000자), `context[]{id, author, text, at}`, `attachments[]{id, name, mime, bytes, url, url_expires_at}`, `memory`(bool), `limits{tier, max_turn_s, budget}`, `expires_at` | `from.name`, `budget{max_tokens, max_usd}` 또는 `null` |
| `work.cancel` | 서버→본체 | `by{kind, id}`, `reason`(코드, 열린 값: user·service_paused 등) | |
| `work.approval_decision` | 서버→본체 | `approval_id`, `decision`(approve·reject·expire), `by{kind:user·system, id}` | |
| `work.accept` | 본체→서버, RPC | 없음(`{}`) | `lease_gen`(정수): 서버가 accept 성공 답으로 준 리스 세대. 연장(5분마다)·이어 하기 accept에 싣는다. 실행 중 메모리에만 둔다 |
| `work.progress` | 본체→`wk:<work>` 방송(저장 안 함) | `stage`(thinking·tool·writing) | `note`(≤200자) |
| `work.approval_request` | 본체→서버 | `approval_id`, `action`, `risk`(low·medium·high), `summary`(≤2,000자), `effect_key`(또는 null), `expires_at` | |
| `work.effect` | 본체→서버 | `effect_key`(≤200자), `state`(intent·done·failed) | `kind`(코드) |
| `work.result` | 본체→서버 | `text`(≤20,000자), `files[]`(업로드 슬롯 id, ≤20), `handoffs[]{agent, text}`(≤8) | `usage{input_tokens, output_tokens, cost_usd, runner, model}` |
| `work.error` | 본체→서버 | `code`(아래 9종, 열린 값), `runner`(또는 null) | `retry_at` |
| `agent.sync` | 본체→서버(등록) | `agents[]{ws, slug, name, role, face_hash}`(≤500) | |

`work.error` 코드: `limit`·`no_runner`·`login`·`timeout`·`cancelled`·`unsupported`·`tier_denied`·`budget`·`internal`. 열린 값이라 받는 쪽은 모르는 코드를 `internal`로 읽는다(`normalizeWorkErrorCode`). 방에는 코드만 남기고 원문을 싣지 않는다(D15).

## 상태

저장하는 상태: `offered → accepted → running ⇄ awaiting_approval → done | failed | cancelled`.
읽을 때 계산하는 상태(`effectiveState`, 크론 없음): offered가 `expires_at`을 넘기면 `expired`. accepted·running·awaiting_approval인데 리스가 끝났고 결과가 없으면 `stalled`(결과 모름, 자동 재실행 없음).

| 지금 \ 봉투 | accept | approval_request | approval_decision | effect | result | error | cancel |
|---|---|---|---|---|---|---|---|
| offered | accepted | ✗ | ✗ | ✗ | ✗ | `unsupported`만 기록(그대로) | cancelled |
| accepted·running | 같은 기기 + 현재 `lease_gen`이면 그대로(리스 연장), 그 밖은 lease_held | awaiting_approval | ✗ | 기록 | done | failed | cancelled |
| awaiting_approval | 같은 기기 + 현재 `lease_gen`이면 그대로(리스 연장), 그 밖은 lease_held | ✗ | running | done·failed만 기록(새 intent ✗) | ✗ | failed | cancelled |
| stalled(같은 기기) | 이어 하기(직전 `lease_gen`)만 running, 그 밖은 not_lease_holder | ✗ | ✗ | done·failed만 기록 | done + `work.late` 표시 | failed + `work.late` 표시 | cancelled |
| stalled(다른 기기) | not_lease_holder | not_lease_holder | — | not_lease_holder | not_lease_holder | not_lease_holder | cancelled |
| done·failed·cancelled | work_closed | work_closed | work_closed | done·failed만 기록(이미 시작한 효과의 결과) | work_closed | cancelled만 기록 | 그대로 |
| expired | work_closed | work_closed | work_closed | work_closed | work_closed | work_closed | 그대로 |

✗ = `invalid_transition`. stalled는 저장하지 않는 계산 상태라, 같은 기기 = 이 일의 리스를 마지막으로 잡았던 기기다(`nextState(…, { sameDevice, leaseGen })`). accept는 같은 기기가 직전 리스 세대를 실어 보낸 "이어 하기"만 받는다. 재시작한 본체는 세대를 모르므로 같은 기기라도 거부된다. 처음부터 다시 돌려 되돌릴 수 없는 일이 다른 키로 두 번 나가는 것을 막기 위해서다(경우 8). 같은 기기의 늦은 result·error는 받아서 일을 끝내고 방 글에 표시 코드 `work.late`(`LATE_MARK`)를 붙인다. 실제로 끝난 일이 "결과 모름"으로 남지 않게 하기 위해서다. 자동 재실행은 없고, 사람이 "다시 시키기"로 새 일을 만들었어도 늦은 결과는 옛 일의 토픽에만 붙는다. 새 `intent`는 accepted·running에서만 받는다. 본체는 intent가 성공해야 되돌릴 수 없는 일을 실행한다(D13).

받을 수 없는 본체(러너 로그인 없음 등)는 accept하지 않는다. 받은 뒤 실패하면 `work.error`를 보낸다. 리스 주인이 아닌 기기는 accept 외의 봉투를 보낼 수 없다(`not_lease_holder`).

## 거부 코드(`msgr2_link_send` 답)

답 모양: 성공 `{ ok: true, duplicate?: true }`(accept 성공이면 `lease_gen`, `lease_until`도 싣는다), 거부 `{ ok: false, code, retry }`.

| 코드 | 다시 보냄 | 뜻 |
|---|---|---|
| `invalid_envelope`·`too_large` | 아니오 | 모양·크기가 계약과 다름 |
| `unsupported_type` | 아니오 | 모르는 type(버전 규칙 1) |
| `wrong_direction` | 아니오 | 본체가 서버 전용 type을 보냄 |
| `link_version_unsupported` | 아니오 | v가 서버 범위 밖 → 본체는 "Argo 업데이트 필요" |
| `device_unknown`·`device_revoked`·`device_expired` | 아니오 | 기기 확인 실패(5절) |
| `service_paused` | 아니오 | v2 중단 스위치 |
| `work_not_found`·`work_closed`·`invalid_transition` | 아니오 | 상태표 밖 |
| `lease_held`·`not_lease_holder` | 아니오 | 담당 기기 한 대(D8). stalled 일에 다른 기기가 보낸 봉투도 `not_lease_holder` |
| `seq_conflict` | 아니오 | 같은 seq에 다른 봉투 |
| `effect_exists`·`effect_unknown` | 아니오 | 이미 있는 키로 intent, intent 없이 결과 |
| `tier_denied` | 아니오 | guest 등급 밖 행동(승인 요청·효과·파일 결과) |
| `upload_slot_invalid` | 아니오 | 결과의 파일 id가 이 일의 슬롯이 아님 |
| `rate_limited`·`internal` | 예(간격·상한, 같은 id·seq) | 일시 오류 |

## 버전 규칙

1. 같은 `v` 안에서는 필드와 열린 값(`work.error` 코드·`cancel.reason`)만 더한다. 모르는 필드는 무시한다(어디에도 `additionalProperties:false`를 두지 않는다). 모르는 type을 받으면 본체는 `work.error{code:'unsupported'}`로 답하고(`unsupportedReply`), 서버는 `unsupported_type`으로 거부한다. 본체는 다시 보내지 않는다.
2. 이름·뜻이 바뀌거나 필드가 빠지거나 닫힌 값(stage·decision·state·tier·risk)이 바뀌면 `v`를 올린다. 서버는 `link_min_v`·`link_max_v` 범위 밖 봉투를 `link_version_unsupported`로 거부한다. 판정 순서상 v 검사가 type 검사보다 먼저다.
3. 기기 등록 때 본체가 `[min, max]`를 알리고, 서버는 겹치는 가장 높은 `v`로 보낸다(`negotiate`).
4. 옛 `v`는 새 `v`를 낸 뒤 30일 동안, 그리고 본체 최소 버전이 새 `v` 지원 판을 넘을 때까지 함께 받는다.
5. 약속이 없는 옛 본체(`src/gateway/msgr.mjs`)는 옛 표만 보고, 옛 표는 영구 중단 상태다.

약속을 바꿀 때는 `v1.mjs`를 고치고 `schema.mjs --write`로 JSON Schema를 다시 만든 뒤, 예제와 시험을 같은 PR에서 고친다(계약 시험이 어긋남을 잡는다).
