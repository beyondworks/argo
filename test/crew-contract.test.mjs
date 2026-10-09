// 크루 계약 레지스트리(2026-09-29, 설계 T9) — Argo 크루(PC 게이트웨이)가 메신저와 주고받는 모든 RPC·표를 외부 에이전트(봇) 경로와
// 대조한다. 그동안 기능이 Argo 경로에만 붙고 외부 에이전트는 "2단계"로 밀렸다(자동화 패널 주석, 결재 카드). 게이트웨이에 새 호출을
// 추가하면 여기서 분류해야 CI가 통과한다 — 봇 대응 RPC / 서버가 판정 / 다음 단계로 미룸 / Argo PC 전용(이유).
// 설계: _argo-internal-docs/docs/external-agent-contract-phase1-2026-09-29.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METHODS } from '../supabase/functions/msgr-bot/core.js';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const CONTRACT = {
  // 대화·실행
  msgr_messages: { bot: ['msgr_bot_send', 'msgr_bot_finish', 'msgr_bot_updates'] },
  msgr_executions: { bot: ['msgr_bot_updates', 'msgr_bot_finish'] },
  msgr_crew_inbox: { bot: ['msgr_bot_updates'] },
  msgr_crew_inbox_many: { bot: ['msgr_bot_updates'] }, // 회사 단위 받은 글 묶음(2026-10-09) — 봇은 토큰 하나 = 에이전트 하나라 getUpdates 한 번이 이미 그 에이전트의 묶음이다
  msgr_crew_context: { bot: ['msgr_bot_updates'] },
  msgr_channels: { bot: ['msgr_bot_updates'] },
  msgr_channel_members: { bot: ['msgr_bot_updates'] },
  msgr_channel_access: { bot: ['msgr_bot_updates'] },
  msgr_crews: { bot: ['msgr_bot_create', 'msgr_bot_me'] },
  msgr_attachments: { bot: ['msgr_bot_file', 'msgr_bot_attach_prepare', 'msgr_bot_attach_commit'] }, // 받기(getFile)·보내기(createUpload·attachFile, 20260930160000)
  msgr_execution_finish: { bot: ['msgr_bot_finish'] },
  msgr_execution_heartbeat: { pending: '2단계 — 긴 실행의 진행 신호(지금 봇은 결재 대기 중에만 msgr_bot_events가 심박을 올린다)' },
  // 자동화(크루 루틴) — 1-a
  msgr_crew_routines_sync: { bot: ['msgr_bot_routines_sync'] },
  msgr_crew_routine_edits_pending: { bot: ['msgr_bot_events'] },
  msgr_crew_routine_edit_done: { bot: ['msgr_bot_routine_edit_done'] },
  msgr_automation_dispatch_due: { server: '조직 자동화는 서버 클라우드 크론 또는 조직 PC가 발송하고, 봇은 멘션 메시지로 받는다(msgr_bot_updates)' },
  // 결재 — 1-a(위험 명령), 1-b(에이전트가 올리는 결재·후속 보고)
  msgr_crew_approvals: { bot: ['msgr_bot_request_approval', 'msgr_bot_request_agent_approval', 'msgr_bot_events', 'msgr_bot_ack_approval', 'msgr_bot_expire_approval'] },
  msgr_create_thread_approval: { bot: ['msgr_bot_request_agent_approval'] }, // 1-b: 에이전트가 올리는 결재(도구)
  msgr_can_decide: { server: '결정은 메신저에서 사람이 하고 RLS가 판정한다 — 크루 쪽 호출 없음' },
  // 개인 공간 crew 1:1 결재(2026-10-08 PR-C, 계획 rc-0195 personal-crew-room-features-plan.md 7절) — 외부 봇 결재(msgr_bot_*)는 별도 경로라 이번 범위 밖
  msgr_create_personal_approval: { pending: '개인 crew 1:1 결재 넣기(본체) — 외부 봇 결재는 msgr_bot_* 별도 경로라 이번 범위 밖, 봇 결재 RPC의 개인 갈래를 정할 때 연다' },
  msgr_is_own_crew_room: { server: '봇 결재 카드는 넣기 트리거(msgr_personal_approval_gate)가 같은 판정(_msgr_own_crew_room)으로 막는다 — 봇 쪽 호출 없음' },
  msgr_post_thread_followup: { bot: ['msgr_bot_followup'] }, // 1-b: 결정 뒤 한 번만 원문 답글
  // 팀 업무
  msgr_work_runs: { bot: ['msgr_bot_updates'] },
  msgr_work_heartbeat: { pending: '2단계 — 업무 창 진행 신호' },
  // 조직·정책·자격 — 봇 RPC 안에서 서버가 판정
  msgr_orgs: { bot: ['msgr_bot_me'] },
  msgr_org_members: { server: '배달 판정(msgr_delivery_allowed)이 서버에서 본다' },
  msgr_org_policies: { server: '결재권·기본 허용 정책은 서버 판정' },
  msgr_org_entitled: { server: '봇 RPC 안에서 판정(msgr_bot_updates_before_work·msgr_bot_events)' },
  msgr_org_entitlement_marker: { server: '봇 RPC 안에서 판정' },
  msgr_org_ai_consent_ok: { server: '봇 RPC 안에서 판정(msgr_ai_consent_visible)' },
  // 개인 공간 에이전트 1단계(2026-09-30) — 외부 봇의 개인 공간 참여는 다음 단계(봇 1:1·개인 방 스캔). 그때 봇 경로를 정한다.
  msgr_personal_ai_consent_ok: { pending: '개인 방 동의 확인 — 봇은 아직 개인 방에 들어가지 않는다(개인 공간 봇 단계에서 봇 RPC 안 판정으로)' },
  msgr_profiles: { argoOnly: '개인 방 지시자 표시 이름(조직 이름이 없는 방) — 봇은 메시지 봉투의 이름을 쓴다' },
  msgr_instruct_check: { server: '배달 전에 서버가 판정(msgr_delivery_allowed)' },
  // 기억·문서
  msgr_crew_memory: { pending: '3단계 — 크루 기억(VPS argo_memory 플러그인과 맞춘다)' },
  msgr_org_docs: { pending: '3단계 — 조직 문서 읽기·제안' },
  // 오피스 일정(에이전트 calendar 도구, 2026-09-30) — Argo 크루는 주인의 기기 세션으로 부른다(src/gateway/office-calendar.mjs)
  office_event_list: { pending: '다음 단계 — 외부 에이전트(봇) 일정 도구. 봇 API 메서드가 아직 없고, 봇 토큰으로 주인 일정을 읽는 범위부터 정해야 한다' },
  office_event_write: { pending: '다음 단계 — 외부 에이전트(봇) 일정 쓰기. 서버는 p_data.crew가 있으면 주인 일정만 고치게 이미 막는다' },
  // 오피스 회사 기록(에이전트 office 도구, 2026-10-02 트랙 C) — Argo 크루는 주인의 기기 세션으로 부른다(src/gateway/office-company.mjs)
  office_company_read: { pending: '다음 단계 — 외부 에이전트(봇) 회사 정보 읽기. 봇 토큰으로 조직 회사 정보를 읽는 범위(견적 작성 봇 등)부터 정한다' },
  office_company_write: { pending: '다음 단계 — 외부 에이전트(봇) 회사 정보 쓰기. 서버가 관리자인지 판정하므로 봇 주인의 역할을 넘겨받는 방식이 필요하다' },
  office_people_read: { pending: '다음 단계 — 외부 에이전트(봇) 직원 명부 읽기. 메모는 관리자만이라 봇 응답 범위를 정해야 한다' },
  office_perf_eval_list: { pending: '다음 단계 — 외부 에이전트(봇) 평가 레포트 읽기. 사람 대상은 본인·관리자만이라 봇 권한 범위부터' },
  // 오피스 브리핑(에이전트 office_briefing 도구, 유건 10/5) — 받는 사람의 내 공간에 모인다(src/gateway/office-briefing.mjs)
  office_briefing_write: { pending: '다음 단계 — 외부 에이전트(봇) 브리핑 쓰기(헤르메스 페퍼 정기 브리핑 이관). 받는 사람·작성자 이름을 봇 토큰에 맞춘다' },
  office_briefing_list: { pending: '다음 단계 — 외부 에이전트(봇) 브리핑 읽기. 주인 개인 기록이라 봇이 읽을 범위부터 정한다' },
  office_briefing_get: { pending: '다음 단계 — 외부 에이전트(봇) 브리핑 한 건 읽기(office_briefing_list와 같은 범위)' },
  office_perf_eval_write: { pending: '다음 단계 — 외부 에이전트(봇) 평가 쓰기(헤르메스 페퍼 루틴 이관). 관리자 판정과 crew 표시를 봇 토큰에 맞춘다' },
  // 오피스 문서함·드라이브(에이전트 office_files 도구, 분리 검수 MEDIUM 4) — Argo 크루는 주인의 기기 세션으로 부른다(src/gateway/office-files.mjs)
  office_file_list: { pending: '다음 단계 — 외부 에이전트(봇) 문서함 검색. 봇 토큰으로 조직 문서함을 읽는 범위(손님 방·통장사본 가림)부터 정한다' },
  office_file_get: { pending: '다음 단계 — 외부 에이전트(봇) 문서함 한 건 읽기. 통장사본 글자는 주인 1:1에서만이라 봇 응답 범위를 정해야 한다' },
  office_file_write: { pending: '다음 단계 — 외부 에이전트(봇) 문서함 올리기(자리 → Storage → 등록). 봇은 주인 JWT가 없어 Storage 올리기 경로부터 정한다' },
  // 오피스 할 일·페이지(에이전트 office_work 도구, 2026-10-04 17차 B-6) — Argo 크루는 주인의 기기 세션으로 부른다(src/gateway/office-work.mjs)
  office_task_list: { pending: '다음 단계 — 외부 에이전트(봇) 할 일 읽기. 봇 토큰으로 주인이 맡은 일만 읽는 범위(남의 일은 그 사람·관리자만)부터 정한다' },
  office_task_write: { pending: '다음 단계 — 외부 에이전트(봇) 할 일 쓰기. 크루는 주인이 맡은 일만 바꾸고 source에 크루를 남기는 규칙을 봇 토큰에 맞춘다' },
  office_task_category_list: { pending: '다음 단계 — 외부 에이전트(봇) 할 일 분류 읽기. 할 일 읽기와 같은 단계에서 연다' },
  office_org_people: { pending: '다음 단계 — 외부 에이전트(봇) 조직 사람 이름 읽기(할 일 맡은 사람 표시). 할 일 읽기와 같은 단계에서 연다' },
  office_page_list_access: { pending: '다음 단계 — 외부 에이전트(봇) 페이지 목록. 비공개·초대 페이지를 여럿이 보는 방에 내지 않는 판정을 봇 응답에 맞춘다' },
  office_pages: { pending: '다음 단계 — 외부 에이전트(봇) 페이지 본문 읽기(RLS office_page_access). 페이지 목록과 같은 단계에서 연다' },
  office_page_create: { pending: '다음 단계 — 외부 에이전트(봇) 페이지 만들기. 최상위는 관리자만이라 봇 주인의 역할을 넘겨받는 방식이 필요하다' },
  office_page_save: { pending: '다음 단계 — 외부 에이전트(봇) 페이지 고치기. 버전 충돌 검사와 글자 아닌 블록 보존 규칙을 봇 경로에도 둔다' },
  // 오피스 거래처·거래(에이전트 office_deals 도구, 17차 B-7) — Argo 크루는 주인의 기기 세션으로 부른다(src/gateway/office-deals.mjs)
  office_business_read: { pending: '다음 단계 — 외부 에이전트(봇) 거래처·거래 읽기. 계좌·가림 칸을 여럿이 보는 방에 내지 않는 판정을 봇 응답에 맞춘다' },
  office_business_write: { pending: '다음 단계 — 외부 에이전트(봇) 거래처·거래 쓰기. 서버가 관리자인지 판정하므로 봇 주인의 역할을 넘겨받는 방식이 필요하다' },
  // 오피스 메일(에이전트 office_mail 도구, 17차 B-8) — 메일 본문은 오피스 서버 함수(api/mail)를 주인 JWT로, 계정 목록만 표에서 읽는다(src/gateway/office-mail.mjs)
  office_mail_accounts: { pending: '다음 단계 — 외부 에이전트(봇) 메일. 봇은 주인 JWT가 없어 오피스 메일 서버 함수를 부를 경로부터 정하고, 보내기는 봇에도 열지 않는다' },
  // Argo PC 전용
  msgr_create_channel: { argoOnly: '크루 1:1 방은 메신저 앱이 만든다 — 봇 1:1 방도 사람이 앱에서 연다' },
  msgr_dm_personal_crew: { argoOnly: '본체 알림을 개인 공간의 크루 1:1(앱이 여는 방과 같은 방)에 올릴 때 방을 찾거나 연다(에이전트 = 한 사람, 2026-10-03) — 외부 에이전트의 알림은 예약 작업 deliver=argo_msgr와 받은 대화로 보내기(msgr_bot_send)로 간다' },
  msgr_crew_requests: { argoOnly: 'Argo PC가 크루를 새로 만드는 영입 요청 — 외부 에이전트는 서버 연결(connect) 절차로 추가한다' },
  msgr_crew_presence: { argoOnly: 'Argo PC에 남은 크루 대화 기록의 회수 판정(유건 결정 2026-10-03) — 외부 에이전트의 기억은 그 에이전트 쪽 저장소라 Argo가 지울 수 없다(봇 연결 해제·채널 빼기까지만)' },
  msgr_role: { argoOnly: 'Argo PC 크루 미러가 조직에 행을 넣기 전 확인(msgr_crews_insert 정책과 같은 함수, 2차 검수 M-2) — 외부 에이전트는 서버 연결(connect) 절차로 추가해 이 확인이 필요 없다' },
  msgr_org_locked: { argoOnly: 'Argo PC 크루 미러가 조직에 행을 넣기 전 확인 — 구독이 연체돼 잠긴 조직은 msgr_crews_insert가 거절한다. 외부 에이전트는 서버 연결 절차로 추가한다' },
  msgr_node_heartbeat: { argoOnly: '상주 노드 심박 — 봇 가용성은 getUpdates의 last_seen_at' },
  msgr_notification_routes_sync: { argoOnly: 'Argo 데스크톱 알림 경로 — 외부 에이전트는 예약 작업 deliver=argo_msgr' },
  msgr_notification_authorize: { argoOnly: 'Argo 데스크톱 알림 경로' },
  msgr_notification_claim: { argoOnly: 'Argo 데스크톱 알림 경로' },
  msgr_notification_finish: { argoOnly: 'Argo 데스크톱 알림 경로' },
};
// 다음 단계로 미룬 항목 — 늘리거나 줄일 때 이 목록을 같이 고친다(조용히 늘지 않게).
const PENDING = ['msgr_create_personal_approval', 'msgr_crew_memory', 'msgr_execution_heartbeat', 'msgr_org_docs', 'msgr_personal_ai_consent_ok', 'msgr_work_heartbeat', 'office_briefing_get', 'office_briefing_list', 'office_briefing_write', 'office_business_read', 'office_business_write', 'office_company_read', 'office_company_write', 'office_event_list', 'office_event_write', 'office_file_get', 'office_file_list', 'office_file_write', 'office_mail_accounts', 'office_org_people', 'office_page_create', 'office_page_list_access', 'office_page_save', 'office_pages', 'office_people_read', 'office_perf_eval_list', 'office_perf_eval_write', 'office_task_category_list', 'office_task_list', 'office_task_write'];

function gatewayCalls() {
  const dir = root('src/gateway');
  const names = new Set();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.mjs'))) {
    const src = readFileSync(`${dir}/${f}`, 'utf8');
    for (const m of src.matchAll(/rpc\('([a-z_]+)'|from\('((?:msgr|office)_[a-z_]+)'\)/g)) names.add(m[1] ?? m[2]); // 표 직접 읽기: 메신저·오피스 표
  }
  return names;
}
const migrations = () => readdirSync(root('supabase/migrations')).map((f) => readFileSync(root(`supabase/migrations/${f}`), 'utf8')).join('\n');

test('Argo 게이트웨이의 메신저 호출은 모두 외부 에이전트 경로가 분류돼 있다', () => {
  const missing = [...gatewayCalls()].filter((n) => !CONTRACT[n]);
  assert.deepEqual(missing, [], `새 게이트웨이 호출 — 외부 에이전트(봇) 경로를 정하고 test/crew-contract.test.mjs에 분류하세요: ${missing.join(', ')}`);
});

test('레지스트리의 봇 RPC는 실제로 마이그레이션에 있고, 엣지 봇 API가 부른다', () => {
  const sql = migrations();
  const core = readFileSync(root('supabase/functions/msgr-bot/core.js'), 'utf8');
  const bots = [...new Set(Object.values(CONTRACT).flatMap((c) => c.bot ?? []))];
  const notInSql = bots.filter((b) => !new RegExp(`function public\\.${b}\\(`).test(sql));
  assert.deepEqual(notInSql, [], `마이그레이션에 없는 봇 RPC: ${notInSql.join(', ')}`);
  const reached = bots.filter((b) => !['msgr_bot_create'].includes(b)); // msgr_bot_create는 관리자가 앱에서 부른다(봇 토큰 경로 아님)
  const notInCore = reached.filter((b) => !core.includes(`'${b}'`) && !(b === 'msgr_bot_updates' && core.includes("'msgr_bot_updates_with_delivery'")));
  assert.deepEqual(notInCore, [], `엣지 봇 API가 부르지 않는 봇 RPC: ${notInCore.join(', ')}`);
});

test('항목마다 분류가 하나 이상이고 이유가 적혀 있으며, 미룬 항목 목록이 명시돼 있다', () => {
  for (const [name, c] of Object.entries(CONTRACT)) {
    assert.ok(c.bot?.length || c.server || c.pending || c.argoOnly, `${name}: 분류 없음`);
    for (const k of ['server', 'pending', 'argoOnly']) if (k in c) assert.ok(String(c[k]).length > 8, `${name}.${k}: 이유가 너무 짧다`);
  }
  assert.deepEqual(Object.keys(CONTRACT).filter((n) => CONTRACT[n].pending).sort(), PENDING);
});

test('봇 API 메서드는 모두 레지스트리의 봇 RPC로 이어진다', () => {
  const byMethod = { getMe: 'msgr_bot_me', getUpdates: 'msgr_bot_updates', sendMessage: 'msgr_bot_send', sendChatAction: 'msgr_bot_typing', getFile: 'msgr_bot_file', createUpload: 'msgr_bot_attach_prepare', attachFile: 'msgr_bot_attach_commit',
    setRoutines: 'msgr_bot_routines_sync', routineEditDone: 'msgr_bot_routine_edit_done', requestApproval: 'msgr_bot_request_approval',
    ackApproval: 'msgr_bot_ack_approval', expireApproval: 'msgr_bot_expire_approval', reportStatus: 'msgr_bot_report_status' };
  assert.deepEqual([...METHODS].sort(), Object.keys(byMethod).sort(), '새 봇 메서드는 여기와 레지스트리에 같이 등록한다');
  // msgr_bot_typing(답변 중 표시)·msgr_bot_report_status(버전·승인 모드 표시)는 Argo 게이트웨이 대응 기능이 없는 봇 전용 표시 경로
  const inContract = new Set(Object.values(CONTRACT).flatMap((c) => c.bot ?? []).concat(['msgr_bot_typing', 'msgr_bot_report_status']));
  const orphan = Object.entries(byMethod).filter(([, rpc]) => !inContract.has(rpc)).map(([m]) => m);
  assert.deepEqual(orphan, [], `레지스트리에 없는 봇 메서드: ${orphan.join(', ')}`);
});
