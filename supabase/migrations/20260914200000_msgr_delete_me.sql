-- 앱 안에서 계정 삭제(App Store 5.1.1(v): 계정을 만들 수 있는 앱은 앱 안에서 삭제도 가능해야 한다 — 이메일 요청 방식은 불충분).
-- 정식 출시 전수 검사(2026-09-14) 차단 항목 2.
--
-- 규칙:
--  · 내가 소유한 조직에 다른 활성 멤버(서비스 계정 제외)가 있으면 먼저 소유권을 넘겨야 한다 → msgr_owner_transfer_required: <조직명들>
--  · 나만 있는 소유 조직은 하드 삭제한다(owner_user_id FK가 restrict라 소유자 행이 남으면 사용자 삭제가 막힌다. 계정이 사라지므로 30일 복구 유예도 의미가 없다).
--  · 내 개인 흔적(프로필·친구·푸시 토큰·읽음·반응·핀/폴더·알림 경로·기기 키)은 지운다. 조직 멤버십은 removed_at으로 닫는다.
--  · 내가 소유한 크루(개인 에이전트)는 auth.users 삭제에 cascade로 함께 지워진다(msgr_crews.owner_user_id). 그 크루의 글은 crew_id가 null이 돼 본문만 남는다.
--  · 내가 만든 채널·문서·작업(created_by NOT NULL, FK 규칙 없음)은 그 조직 소유자에게 넘긴다. 추가자·결재자 표시(nullable)는 비운다.
--  · 공유 공간(채널·1:1)에 남긴 메시지 본문은 팀의 기록이라 지우지 않는다. 프로필이 사라져 작성자는 이름 없이 표시된다.
--  · 마지막으로 auth.users 행을 지운다(GoTrue의 identities·sessions·refresh_tokens는 FK cascade).
-- 멤버 자기 갱신 가드는 본인의 removed_at 변경을 막는다(관리자 아님) — 계정 삭제 함수 안에서만 트랜잭션 지역 플래그로 통과시킨다.
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

-- 불변 컬럼 잠금(msgr_lock_cols)은 auth.uid()가 있는 문맥의 created_by 변경을 막는다 — 계정 삭제의 소유자 이관만 같은 플래그로 통과.
create or replace function public.msgr_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if; -- FK 캐스케이드(on delete set null)·다른 트리거의 내부 UPDATE는 통과(실측: 크루 삭제가 막혔다)
  if current_setting('argo.msgr_account_delete', true) = '1' then return new; end if; -- msgr_delete_me 전용(트랜잭션 지역): 내가 만든 채널·문서·작업을 조직 소유자에게 이관
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then raise exception 'msgr_immutable_%', col; end if;
  end loop;
  return new;
end $$;

-- 메시지 CHECK는 author_kind='user'에 author_user_id NOT NULL을 요구했다 → auth.users 삭제(FK set null)가 CHECK 위반으로 막혀
-- 글을 쓴 사용자는 누구도 삭제될 수 없었다(드릴 실측). 탈퇴한 사용자의 글(author_user_id null)을 허용한다 — 삽입은 RLS가 여전히
-- author_user_id = auth.uid()를 강제하므로 null은 FK 캐스케이드로만 생긴다.
alter table public.msgr_messages drop constraint if exists msgr_messages_check;
alter table public.msgr_messages add constraint msgr_messages_check
  check ((author_kind = 'user' and crew_id is null) or (author_kind = 'crew') or (author_kind = 'system'));

create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  blocked text;
  n_orgs int := 0;
begin
  if me is null then raise exception 'msgr_unauthenticated'; end if;

  select string_agg(o.name, ', ' order by o.name) into blocked
    from public.msgr_orgs o
   where o.owner_user_id = me and o.deleted_at is null
     and exists (select 1 from public.msgr_org_members m
                  where m.org_id = o.id and m.user_id <> me and m.removed_at is null
                    and (o.service_user_id is null or m.user_id <> o.service_user_id));
  if blocked is not null then
    raise exception 'msgr_owner_transfer_required: %', blocked;
  end if;

  perform set_config('argo.msgr_account_delete', '1', true); -- 이 트랜잭션 안에서만 자기 멤버십 종료 허용
  -- 다른 조직에 남는 내 흔적 중 FK가 사용자 삭제를 막는 것(created_by NOT NULL·규칙 없음)은 조직 소유자에게 넘긴다
  update public.msgr_channels c set created_by = o.owner_user_id from public.msgr_orgs o where o.id = c.org_id and c.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set created_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set updated_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.updated_by = me and o.owner_user_id <> me;
  update public.msgr_work_runs w set created_by = o.owner_user_id from public.msgr_orgs o where o.id = w.org_id and w.created_by = me and o.owner_user_id <> me;
  update public.msgr_channel_members set added_by = null where added_by = me;
  update public.msgr_crew_approvals set decided_by = null where decided_by = me;
  update public.msgr_orgs set pending_owner_user_id = null where pending_owner_user_id = me;
  update public.msgr_orgs set successor_user_id = null where successor_user_id = me;

  -- 혼자인 소유 조직은 하드 삭제(자식은 전부 cascade)
  delete from public.msgr_orgs where owner_user_id = me;
  get diagnostics n_orgs = row_count;

  delete from public.msgr_channel_members where member_kind = 'user' and member_id = me;
  update public.msgr_org_members set removed_at = now() where user_id = me and removed_at is null;
  delete from public.msgr_push_tokens where user_id = me;
  delete from public.msgr_reads where user_id = me;
  delete from public.msgr_reactions where user_id = me;
  delete from public.msgr_channel_prefs where user_id = me;
  delete from public.msgr_target_prefs where user_id = me;
  delete from public.msgr_friends where a = me or b = me;
  delete from public.msgr_notification_deliveries where owner_user_id = me;
  delete from public.msgr_notification_routes where owner_user_id = me;
  delete from public.msgr_profiles where user_id = me;
  if to_regclass('public.device_keys') is not null then
    update public.device_keys set revoked_at = now() where user_id = me and revoked_at is null;
  end if;

  delete from auth.users where id = me;
  return jsonb_build_object('deleted_orgs', n_orgs);
end $$;
revoke all on function public.msgr_delete_me() from public, anon;
grant execute on function public.msgr_delete_me() to authenticated;
