-- 개인 공간 결재(2026-10-08, 계획 artifacts/rc-0195/personal-crew-room-features-plan.md 5-2 PR-A) — 주인과 자기 에이전트만 있는
-- crew 1:1 방(personal_pair = 'crew:<에이전트 id>')에서만 org_id 없는 결재 행을 넣고, 위험 등급과 무관하게 크루 주인이 확정한다.
-- 넣는 길은 정의자 RPC msgr_create_personal_approval 하나다(PR-C 본체가 부른다). 표 직접 넣기 정책(msgr_approvals_insert)은 배포본 그대로 둔다.
--   왜(1차 재검수 MEDIUM, 계획 5-2 #4와 다름): 옛 본체(0.1.97)도 org 없는 행을 표에 바로 넣으려 한다 — crew 1:1의 D28 고위험 셸 결재.
--   chat.mjs:1425가 messengerOrigin 오류를 삼켜 gateMsgr = {} → permission-gate가 목적지 없이 결재를 만들고 → msgr.mjs:1825가 실행 중 문맥
--   (org NULL)으로 insertApproval을 부른다. 배포본에서 이 넣기는 RLS 오류(42501)로 실패하고, 옛 본체는 결재를 로컬에 남겨 승인 뒤 같은 명령을 한 번
--   실행한다. 정책에 개인 갈래를 열면 그 넣기가 들어가 카드만 생기고, 승인 뒤 이어 실행이 '메신저 실행 소유자·회사 불일치'(msgr.mjs:1311)로
--   실패하며 재시도마다 카드가 쌓인다(배포본보다 나쁜 칸). 정책을 그대로 두면 옛 본체의 넣기는 같은 오류·같은 SQLSTATE를 받는다
--   (pg 드릴 '경우 17(D28)'이 origin/main과 이 파일 양쪽에서 같은 단언으로 잠근다).
-- 친구 1:1·개인 그룹·남의 crew 방은 세 겹에서 닫는다:
--   ① 넣기 RPC — 호출자가 그 crew 1:1의 크루 주인일 때만(공개 판정 msgr_is_own_crew_room), 열은 함수가 정한다(org NULL·pending·확정 열 없음).
--   ② BEFORE INSERT 트리거 — org_id NULL 행은 내부 판정을 통과할 때만. RLS를 거치지 않는 정의자 함수(msgr_create_thread_approval·
--      _msgr_bot_approval_card·msgr_bot_request_approval)도 여기서 걸린다. NOT NULL만 풀면 그 함수들이 크루의 org(NULL)나 인자 p_org를 그대로 넣어
--      친구 방에도 결재 행이 생긴다. 옛 본체가 정의자 함수로 개인 행을 만드는 갈래는 없다: msgr_create_thread_approval은 서버가 delegated를 줄 때만
--      부르고(msgr.mjs:1853), delegated는 '크루가 그 방에 없음'(msgr_crew_context)이라 crew 1:1에서는 거짓이다. 봇 카드는 조직 봇 크루(msgr_bots.org_id NOT NULL)로 넣는다.
--   ③ 결정(msgr_can_decide·msgr_approvals_decide·msgr_approval_deciders) — 확정하는 순간에도 방이 crew 1:1이어야 한다.
-- 판정 조건(계획 5-1): 채널 org NULL·dm·보관 안 됨·personal_pair = 'crew:'||크루, 크루 org NULL·active, 사람 참여 행은 주인 하나
--   (msgr_dm_shape는 짝 방에 사람 둘까지 허용한다), 에이전트 참여 행은 그 크루 하나(주인이 crew 1:1에 다른 크루를 들이면 닫힌다).
-- 기존 동작: 조직 결재의 넣기·판정·정책·감사·방송은 그대로다. 아래 함수·정책은 저장소 최신 정의를 그대로 옮기고 갈래만 더했다
--   (출처: msgr_can_decide·msgr_approval_deciders·msgr_approvals_decide = 20260918193000, msgr_approval_broadcast = 20260918184500
--    — 2026-10-08 운영 prosrc·pg_policies md5가 이 정의와 같음을 읽기 전용으로 확인).
-- 감사: 개인 결재는 감사 표(msgr_audit_log.org_id NOT NULL)에 쓰지 않는다 — 기록은 결재 행의 decided_by·decided_at.
--   계획의 추론("방송 트리거의 감사 쓰기 때문에 개인 확정이 실패")은 드릴에서 틀렸다: msgr_audit(20260903120000 J-5 가드)가 조직이 없으면
--   이미 조용히 건너뛴다(7의 조건을 지운 변이에서도 확정 성공). 7의 조건은 그 뜻을 드러내고, 그 가드가 바뀌어도 개인 확정이 되돌려지지 않게 둔 한 겹이다.
-- DB 부하: 주기 호출·폴링·유휴 쓰기 없음, 새 누적 표 없음. 넣기 1건마다 판정 1~2회(채널·크루 기본 키 + 그 방 참여 행 기본 키 범위),
--   결정 UPDATE·결재 방송마다 판정 1~2회. 개인 갈래는 모두 org_id IS NULL 조건과 묶여 있어 조직 결재에서는 거짓이다
--   (msgr_can_decide는 case로 갈라 조직 행에서 판정 함수를 부르지 않는다. 정책·집합의 and/or는 평가 순서가 보장되지 않아 부를 수도 있다 — 결과는 같다).

set local lock_timeout = '5s'; -- alter table·create trigger·정책 교체는 결재 표에 강한 잠금을 건다 — 긴 쿼리 뒤에서 기다리며 뒤 요청을 줄 세우지 않고 실패한다(다시 실행하면 된다)

-- 1) 판정 — 내부(auth를 보지 않는다: 트리거·확정권자 집합용, 권한 전부 회수) / 공개(호출자 = 크루 주인: 넣기 RPC·정책·본체용)
create or replace function public._msgr_own_crew_room(p_channel uuid, p_crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels ch join public.msgr_crews c on c.id = p_crew
       where ch.id = p_channel and ch.org_id is null and ch.kind = 'dm' and ch.archived_at is null
         and ch.personal_pair = 'crew:' || p_crew::text
         and c.org_id is null and c.status = 'active' and c.owner_user_id is not null
         and (select count(*) from public.msgr_channel_members m where m.channel_id = ch.id and m.member_kind = 'user') = 1
         and exists (select 1 from public.msgr_channel_members m where m.channel_id = ch.id and m.member_kind = 'user' and m.member_id = c.owner_user_id)
         and (select count(*) from public.msgr_channel_members m where m.channel_id = ch.id and m.member_kind = 'crew') = 1
         and public.msgr_crew_in_channel(ch.id, c.id)
    )
$$;
revoke all on function public._msgr_own_crew_room(uuid, uuid) from public, anon, authenticated;

create or replace function public.msgr_is_own_crew_room(p_channel uuid, p_crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(auth.uid() is not null
      and exists (select 1 from public.msgr_crews c where c.id = p_crew and c.owner_user_id = auth.uid())
      and public._msgr_own_crew_room(p_channel, p_crew), false)
$$;
revoke all on function public.msgr_is_own_crew_room(uuid, uuid) from public, anon;
grant execute on function public.msgr_is_own_crew_room(uuid, uuid) to authenticated;

-- 2) 표 — org_id NULL 허용(개인 결재), 개인 결재에는 조직 문서 제안 금지(개인 공간에 조직 문서가 없다 — msgr_apply_org_doc은 org_doc만 반영)
alter table public.msgr_crew_approvals alter column org_id drop not null;
alter table public.msgr_crew_approvals drop constraint if exists msgr_crew_approvals_personal_no_org_doc;
alter table public.msgr_crew_approvals add constraint msgr_crew_approvals_personal_no_org_doc check (org_id is not null or kind <> 'org_doc');

-- 3) 넣기 트리거 — org_id NULL 행은 내부 판정을 통과할 때만. 정의자 함수 경로도 여기서 걸린다(RLS를 거치지 않으므로).
--    오류 이름은 봇 엣지 ERR 표에 이미 있는 msgr_not_allowed(403)를 쓴다 — 모르는 이름은 엣지에서 500이 된다(20261001140000 H1).
create or replace function public.msgr_personal_approval_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.org_id is null and not public._msgr_own_crew_room(new.channel_id, new.crew_id) then
    raise exception 'msgr_not_allowed' using errcode = '42501', detail = 'personal_approval_room';
  end if;
  return new;
end $$;
revoke all on function public.msgr_personal_approval_gate() from public, anon, authenticated;
drop trigger if exists msgr_personal_approval_gate on public.msgr_crew_approvals;
create trigger msgr_personal_approval_gate before insert on public.msgr_crew_approvals for each row execute function public.msgr_personal_approval_gate();

-- 4) 개인 결재 넣기 RPC — org 없는 결재 행을 사용자가 넣는 유일한 길(PR-C 본체). 넣기 정책은 배포본 그대로라 표 직접 넣기는 지금처럼 거절된다(머리 주석).
--    인자는 본체가 표에 넣던 행 객체 그대로(msgr.mjs msgrPush의 approval), 결과 {id}도 insertApproval과 같다 — 카드 글·message_id 연결·판정은 조직과 같은 길.
--    정의자 함수라 RLS를 거치지 않으므로 넣기 정책이 하던 일을 여기서 한다: 호출자 = 크루 주인(공개 판정), status는 pending 고정.
--    받는 키는 본체가 보내는 열뿐이다 — status·decided_by·decided_at·message_id·dm_source_msg_id 같은 키는 거절한다(정책은 decided_by를 막지 않았다).
--    표 제약·출처 가드(a_msgr_approval_source_guard: 원문의 실행이 running)·넣기 트리거·고유 (crew_id, approval_id)는 그대로 돈다.
--    옛 서버에는 이 함수가 없다(PGRST202) — 본체는 그때 넣기를 시도하지 않은 것으로 다룬다(계획 5-3 #2와 같은 방향).
create or replace function public.msgr_create_personal_approval(p_row jsonb) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_crew_approvals;
begin
  if jsonb_typeof(p_row) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(p_row) k
                 where k not in ('org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'reason', 'risk', 'kind', 'payload', 'source_msg_id'))
     or (p_row ? 'org_id' and jsonb_typeof(p_row->'org_id') <> 'null') then
    raise exception 'msgr_approval_invalid' using errcode = '22023';
  end if;
  if not public.msgr_is_own_crew_room((p_row->>'channel_id')::uuid, (p_row->>'crew_id')::uuid) then
    raise exception 'msgr_not_allowed' using errcode = '42501', detail = 'personal_approval_room';
  end if;
  insert into public.msgr_crew_approvals (org_id, channel_id, crew_id, approval_id, action, reason, status, risk, kind, payload, source_msg_id)
    values (null, (p_row->>'channel_id')::uuid, (p_row->>'crew_id')::uuid, p_row->>'approval_id', p_row->>'action', p_row->>'reason', 'pending',
            coalesce(p_row->>'risk', 'low'), coalesce(p_row->>'kind', 'action'), nullif(p_row->'payload', 'null'::jsonb), (p_row->>'source_msg_id')::bigint)
    returning * into a;
  return jsonb_build_object('id', a.id);
end $$;
revoke all on function public.msgr_create_personal_approval(jsonb) from public, anon;
grant execute on function public.msgr_create_personal_approval(jsonb) to authenticated;

-- 5) 확정권 판정 — 20260918193000 정의 그대로 + 맨 앞 개인 갈래(위험 등급과 무관하게 crew 1:1의 크루 주인, 확정 시점의 방 모양으로)
create or replace function public.msgr_can_decide(ap uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(case when a.org_id is null then c.owner_user_id = auth.uid() and public._msgr_own_crew_room(a.channel_id, a.crew_id)
                         else public.msgr_is_member(a.org_id) and case
      when a.risk = 'low' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'owner' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'approvers' then coalesce(public.msgr_is_admin(a.org_id), false)
        or (public.msgr_role(a.org_id) in ('owner', 'admin', 'member') and auth.uid() = any (coalesce(p.approver_user_ids, '{}'::uuid[])))
      else public.msgr_is_admin(a.org_id)
    end end, false)
      from public.msgr_crew_approvals a
      join public.msgr_crews c on c.id = a.crew_id
      left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap
$$;

-- 6) 확정권자 집합(방송 수신자) — 20260918193000 정의 그대로 + 개인 갈래. u ∈ deciders(ap) ⇔ msgr_can_decide(ap) as u (pg 대조 시험이 개인 칸까지 잠근다).
--    조직 갈래 셋은 org NULL 행에서 0행이다(cur·정책 조인이 org_id로 묶인다).
create or replace function public.msgr_approval_deciders(ap uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    with cur as (select om.user_id, om.role from public.msgr_crew_approvals a
                   join public.msgr_orgs o on o.id = a.org_id and o.deleted_at is null
                   join public.msgr_org_members om on om.org_id = a.org_id and om.removed_at is null and (om.expires_at is null or om.expires_at > now())
                  where a.id = ap)
    select k.owner_user_id
      from public.msgr_crew_approvals a join public.msgr_crews k on k.id = a.crew_id left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap and (a.risk = 'low' or coalesce(p.approval_high_by, 'admin') = 'owner')
       and k.owner_user_id in (select user_id from cur)
    union
    select cur.user_id
      from public.msgr_crew_approvals a left join public.msgr_org_policies p on p.org_id = a.org_id, cur
     where a.id = ap and a.risk <> 'low' and coalesce(p.approval_high_by, 'admin') <> 'owner' and cur.role in ('owner', 'admin')
    union
    select u
      from public.msgr_crew_approvals a join public.msgr_org_policies p on p.org_id = a.org_id, unnest(coalesce(p.approver_user_ids, '{}'::uuid[])) u
     where a.id = ap and a.risk <> 'low' and p.approval_high_by = 'approvers'
       and u in (select user_id from cur where role in ('owner', 'admin', 'member'))
    union
    select k.owner_user_id
      from public.msgr_crew_approvals a join public.msgr_crews k on k.id = a.crew_id
     where a.id = ap and a.org_id is null and public._msgr_own_crew_room(a.channel_id, a.crew_id)
$$;
revoke all on function public.msgr_approval_deciders(uuid) from public, anon, authenticated;

-- 7) 확정 정책 — 20260918193000 정의 그대로. 크루 소유자 갈래(본체의 카드 연결 message_id 등 pending 유지 갱신)의 "현재 멤버" 조건에
--    개인 갈래(org NULL이면 호출자의 crew 1:1)를 더한다. 확정(최종 상태) 갈래는 msgr_can_decide가 개인 칸을 판정한다.
--    옛 본체·옛 앱은 개인 결재 행을 만들 수 없으므로(위 4·머리 주석) 이 갈래가 닿는 행도 없다.
drop policy if exists msgr_approvals_decide on public.msgr_crew_approvals;
create policy msgr_approvals_decide on public.msgr_crew_approvals for update to authenticated
  using (status = 'pending' and (public.msgr_can_decide(id)
         or ((public.msgr_is_member(org_id) or (org_id is null and public.msgr_is_own_crew_room(channel_id, crew_id)))
             and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))))
  with check ((status = 'pending' and decided_by is null
                and (public.msgr_is_member(org_id) or (org_id is null and public.msgr_is_own_crew_room(channel_id, crew_id)))
                and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))
           or (status in ('approved', 'rejected', 'expired') and decided_by = (select auth.uid()) and public.msgr_can_decide(id)));

-- 8) 결재 방송 — 20260918184500 정의 그대로 + 감사는 조직 결재만(머리 주석 '감사' — msgr_audit의 조직 존재 가드와 겹치는 명시적 한 겹).
--    방송은 그대로: org NULL이면 msgr_room_send가 u:<방 사람·크루 주인> + 확정권자(위 6)로 보낸다.
create or replace function public.msgr_approval_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.msgr_room_send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'crew_id', new.crew_id, 'approval_id', new.approval_id, 'status', new.status),
    'approval', new.org_id, new.channel_id, array(select public.msgr_approval_deciders(new.id)));
  if tg_op = 'UPDATE' and new.status <> old.status and new.org_id is not null then
    perform public.msgr_audit(new.org_id, 'approval.' || new.status, 'approval', new.approval_id, jsonb_build_object('crew_id', new.crew_id));
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
