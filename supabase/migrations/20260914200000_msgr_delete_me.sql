-- 앱 안에서 계정 삭제(App Store 5.1.1(v): 계정을 만들 수 있는 앱은 앱 안에서 삭제도 가능해야 한다 — 이메일 요청 방식은 불충분).
-- 정식 출시 전수 검사(2026-09-14) 차단 항목 2. 분리 검수 2R(반려) 반영본.
--
-- 규칙:
--  · 내가 소유한 조직(보관 중 포함)에 다른 활성 멤버(서비스 계정·만료 게스트 제외)가 있으면 먼저 소유권을 넘겨야 한다
--    → msgr_owner_transfer_required: <조직명들>. 그 외 소유 조직(나만 있는 것)은 하드 삭제한다(owner FK restrict, 계정이 사라지므로 30일 복구 무의미).
--  · 내가 만든 채널·문서·작업(created_by/updated_by NOT NULL, FK 규칙 없음)은 그 조직 소유자에게 넘긴다. 추가자·결재자 표시(nullable)는 비운다.
--  · 회사 노드 서비스 계정·후계자·이전 제안 지정은 비운다(트리거의 소유자 검사는 이 함수 안에서만 플래그로 통과).
--  · 내 공개 아바타 파일(msgr-avatars/avatars/<uid>/…)과 하드 삭제되는 조직의 첨부 파일(msgr/<org>/…)은 storage.objects에서 지운다.
--    실제 Supabase는 storage.objects 직접 삭제를 트리거로 막는다(storage.allow_delete_query='true'일 때만 허용) → 함수 안에서 트랜잭션 지역으로 켠다.
--  · 공유 공간의 메시지 본문은 팀의 기록이라 남긴다. auth.users 삭제(FK cascade)로 작성자 참조가 null이 되어 '탈퇴한 사용자'로 보인다.
--  · 플래그는 함수가 끝나거나 예외로 빠질 때 되돌린다(자기 역할 상승 가드가 세션에 열린 채 남지 않게).
-- 메시지 CHECK: author_kind='user'에 author_user_id NOT NULL을 요구해 FK set null이 CHECK 위반으로 막혀 글을 쓴 사용자는 누구도 삭제될 수
-- 없었다(드릴 실측). 탈퇴한 사용자의 글(author_user_id null)을 허용한다 — 삽입은 RLS가 여전히 author_user_id = auth.uid()를 강제한다.
alter table public.msgr_messages drop constraint if exists msgr_messages_check;
alter table public.msgr_messages add constraint msgr_messages_check
  check ((author_kind = 'user' and crew_id is null) or (author_kind = 'crew') or (author_kind = 'system'));

-- 가드 4종에 플래그 통과(맨 앞) — 본문은 20260903120000 최신 정의 그대로
create or replace function public.msgr_member_self_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_setting('argo.msgr_account_delete', true) = '1' then return new; end if; -- msgr_delete_me 전용(트랜잭션 지역)
  -- 본인 갱신(관리자 아님)은 표시명만 — 역할·제거 표시·소속은 관리자 정책으로만. NULL 주의: is_admin은 서비스 문맥에서 NULL.
  if auth.uid() = old.user_id and not coalesce(public.msgr_is_admin(old.org_id), false)
     and (new.role <> old.role or new.removed_at is distinct from old.removed_at or new.expires_at is distinct from old.expires_at) then
    raise exception 'msgr_member_self_only_name';
  end if;
  return new;
end $$;

create or replace function public.msgr_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if; -- FK 캐스케이드(on delete set null)·다른 트리거의 내부 UPDATE는 통과(실측: 크루 삭제가 막혔다)
  if current_setting('argo.msgr_account_delete', true) = '1' then return new; end if; -- msgr_delete_me 전용: 내가 만든 채널·문서·작업을 조직 소유자에게 이관
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then raise exception 'msgr_immutable_%', col; end if;
  end loop;
  return new;
end $$;

create or replace function public.msgr_doc_before_write() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and current_setting('argo.msgr_account_delete', true) = '1' then return new; end if; -- msgr_delete_me 전용: 작성자·수정자 이관만(버전·수정 시각 불변)
  if new.channel_id is not null then
    select org_id into new.org_id from public.msgr_channels where id = new.channel_id; -- 채널 문서의 org는 채널의 org(위조 무력화)
    if new.org_id is null then raise exception 'msgr_doc_channel_missing'; end if;
  end if;
  if tg_op = 'UPDATE' then
    new.version := old.version + 1; new.updated_at := now(); new.updated_by := coalesce(auth.uid(), old.updated_by); -- 갱신마다 버전 +1(서비스 문맥은 이전 갱신자 유지)
  end if;
  return new;
end $$;

create or replace function public.msgr_org_before_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); my_role text;
begin
  if current_setting('argo.msgr_account_delete', true) = '1' then return new; end if; -- msgr_delete_me 전용(트랜잭션 지역): 후계자·이전 제안·서비스 계정 정리
  my_role := case when me is null then null else public.msgr_role(old.id) end;
  -- 삭제 표시·복구는 소유자 계정 기준(삭제된 조직은 msgr_role이 null이라 역할로는 판정 불가)
  if me is not null and new.deleted_at is distinct from old.deleted_at and old.owner_user_id <> me then raise exception 'msgr_owner_only'; end if;
  if new.deleted_at is distinct from old.deleted_at then
    perform public.msgr_audit(old.id, case when new.deleted_at is null then 'org.restore' else 'org.delete' end, 'org', old.id::text, jsonb_build_object('at', coalesce(new.deleted_at, old.deleted_at)));
    if new.deleted_at is not null then new.pending_owner_user_id := null; end if;
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    if me is not null then
      if not (new.owner_user_id = me and coalesce(old.pending_owner_user_id = me, false)) then
        if my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
        raise exception 'msgr_transfer_needs_accept';
      end if;
    end if;
    if not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.owner_user_id and removed_at is null) then
      raise exception 'msgr_owner_not_member';
    end if;
    update public.msgr_org_members set role = 'admin' where org_id = old.id and user_id = old.owner_user_id;
    update public.msgr_org_members set role = 'owner' where org_id = old.id and user_id = new.owner_user_id;
    new.pending_owner_user_id := null;
    if new.successor_user_id = new.owner_user_id then new.successor_user_id := null; end if;
    if new.auto_join_domain is not null and new.auto_join_domain is distinct from public.msgr_email_domain(new.owner_user_id) then new.auto_join_domain := null; end if; -- 검수 L-2: 새 소유자 도메인과 다르면 자동 가입 해제
    perform public.msgr_audit(old.id, 'org.transfer', 'user', new.owner_user_id::text, jsonb_build_object('from', old.owner_user_id));
  end if;
  if new.pending_owner_user_id is distinct from old.pending_owner_user_id and new.owner_user_id = old.owner_user_id and new.deleted_at is not distinct from old.deleted_at then
    if me is not null and my_role is distinct from 'owner' and not (new.pending_owner_user_id is null and coalesce(old.pending_owner_user_id = me, false)) then raise exception 'msgr_owner_only'; end if;
    if new.pending_owner_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.pending_owner_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_transfer_not_admin';
    end if;
    perform public.msgr_audit(old.id, case when new.pending_owner_user_id is null then (case when coalesce(me = old.pending_owner_user_id, false) then 'org.transfer.decline' else 'org.transfer.cancel' end) else 'org.transfer.offer' end,
                              'user', coalesce(new.pending_owner_user_id, old.pending_owner_user_id)::text);
  end if;
  if new.successor_user_id is distinct from old.successor_user_id and new.owner_user_id = old.owner_user_id then
    if me is not null and my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
    if new.successor_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.successor_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_successor_not_admin';
    end if;
    perform public.msgr_audit(old.id, 'org.successor', 'user', coalesce(new.successor_user_id, old.successor_user_id)::text, jsonb_build_object('set', new.successor_user_id is not null));
  end if;
  if new.service_user_id is distinct from old.service_user_id then
    -- 검수 H-6: 관리자가 자기를 서비스 계정으로 지정해 개인 크루를 회사 크루로 승격하던 경로 — 소유자 또는 노드 수락 RPC(세션 플래그)만
    if me is not null and my_role is distinct from 'owner' and coalesce(current_setting('msgr.node_accept', true), '') <> '1' then raise exception 'msgr_owner_only'; end if;
    if new.service_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.service_user_id and removed_at is null) then
      raise exception 'msgr_service_not_member';
    end if;
    perform public.msgr_audit(old.id, 'org.service_account', 'org', old.id::text, jsonb_build_object('from', old.service_user_id, 'to', new.service_user_id));
  end if;
  return new;
end $$;

create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  blocked text;
  owned uuid[];
  n_orgs int := 0;
begin
  if me is null then raise exception 'msgr_unauthenticated'; end if;

  -- 다른 활성 멤버(서비스 계정·만료 게스트 제외)가 있는 소유 조직 — 보관 중이어도 남의 기록이므로 이전이 먼저(2R H-1·M-1)
  select string_agg(o.name, ', ' order by o.name) into blocked
    from public.msgr_orgs o
   where o.owner_user_id = me
     and exists (select 1 from public.msgr_org_members m
                  where m.org_id = o.id and m.user_id <> me and m.removed_at is null
                    and (m.expires_at is null or m.expires_at > now())
                    and (o.service_user_id is null or m.user_id <> o.service_user_id));
  if blocked is not null then
    raise exception 'msgr_owner_transfer_required: %', blocked;
  end if;

  perform set_config('argo.msgr_account_delete', '1', true); -- 이 함수 안에서만 가드 통과. 끝·예외에서 되돌린다(2R H-2)

  -- 다른 조직에 남는 내 흔적 중 FK가 사용자 삭제를 막는 것(created_by/updated_by NOT NULL·규칙 없음)은 조직 소유자에게 넘긴다
  update public.msgr_channels c set created_by = o.owner_user_id from public.msgr_orgs o where o.id = c.org_id and c.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set created_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set updated_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.updated_by = me and o.owner_user_id <> me;
  update public.msgr_work_runs w set created_by = o.owner_user_id from public.msgr_orgs o where o.id = w.org_id and w.created_by = me and o.owner_user_id <> me;
  update public.msgr_channel_members set added_by = null where added_by = me;
  update public.msgr_crew_approvals set decided_by = null where decided_by = me;
  -- 회사 노드 서비스 계정·후계자·이전 제안(2R C-2·C-3)
  update public.msgr_orgs set service_user_id = null where service_user_id = me;
  update public.msgr_orgs set pending_owner_user_id = null where pending_owner_user_id = me;
  update public.msgr_orgs set successor_user_id = null where successor_user_id = me;

  -- 내 채널 멤버십(폴리모픽 — FK 없음)과 조직 멤버십 종료(오프보딩 사슬: 크루 분리·채널 회수)
  delete from public.msgr_channel_members where member_kind = 'user' and member_id = me;
  update public.msgr_org_members set removed_at = now() where user_id = me and removed_at is null;

  -- 나만 남은 소유 조직: 첨부 파일 → 조직(자식 cascade) 순으로 하드 삭제. 위 검사로 다른 활성 멤버가 있는 조직은 여기 없다
  select coalesce(array_agg(id), '{}'::uuid[]) into owned from public.msgr_orgs where owner_user_id = me;
  perform set_config('storage.allow_delete_query', 'true', true); -- storage-api의 직접 삭제 가드(protect_objects_delete) 통과 — 트랜잭션 지역. 행이 사라지면 공개 URL·서명 URL 모두 404. 백엔드 바이트는 msgr_purge_orgs와 같이 남는다(알려진 한계, 로컬 스택 E2E 실측)
  if array_length(owned, 1) > 0 then
    delete from storage.objects where bucket_id = 'msgr' and (storage.foldername(name))[1] = any (owned::text[]);
    delete from public.msgr_orgs where id = any (owned);
    get diagnostics n_orgs = row_count;
  end if;
  -- 공개 아바타(msgr-avatars/avatars/<uid>/…)는 계정과 함께(2R M-2)
  delete from storage.objects where bucket_id = 'msgr-avatars' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = me::text;
  if to_regclass('public.device_keys') is not null then
    update public.device_keys set revoked_at = now() where user_id = me and revoked_at is null;
  end if;

  -- 프로필·친구·푸시 토큰·읽음·반응·핀·알림 경로·멤버십·크루·초대는 auth.users FK cascade
  delete from auth.users where id = me;
  perform set_config('argo.msgr_account_delete', '', true);
  return jsonb_build_object('deleted_orgs', n_orgs);
exception when others then
  perform set_config('argo.msgr_account_delete', '', true);
  raise;
end $$;
revoke all on function public.msgr_delete_me() from public, anon;
grant execute on function public.msgr_delete_me() to authenticated;
