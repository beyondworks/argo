-- 채널 관리 3종(유건 요청 2026-09-11): ① 공개 채널에서도 채널 관리자가 멤버·에이전트를 내보낸다(제외 목록 — 공개 채널은 구성원이 암묵이라 행 삭제로는 안 된다)
-- ② 채널 삭제(보관이 아닌 영구 삭제, 첨부 저장소까지) ③ 1:1 대화는 두 참가자 누구나 종료(보관)·삭제할 수 있다.
alter table public.msgr_channels add column if not exists excluded_user_ids uuid[] not null default '{}';
alter table public.msgr_channels add column if not exists excluded_crew_ids uuid[] not null default '{}';

-- 관리 권한: 생성자·채널 관리자·(DM 아닌 채널의) 조직 관리자 + DM은 참가자 본인
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids)
                          or (c.kind <> 'dm' and coalesce(public.msgr_is_admin(c.org_id), false))
                          or (c.kind = 'dm' and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())))
                     and coalesce(public.msgr_is_member(c.org_id), false))
$$;

-- 공개 채널 열람: 제외된 사람은 못 본다(메시지·첨부·채널 목록 모두 이 판정을 탄다)
create or replace function public.msgr_can_read_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels c
       where c.id = ch and (
         (c.kind = 'public' and public.msgr_role(c.org_id) in ('owner', 'admin', 'member') and not (auth.uid() = any (c.excluded_user_ids)))
         or exists (select 1 from public.msgr_channel_members m
                     where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()
                       and public.msgr_is_member(c.org_id))
       )
    )
$$;
drop policy if exists msgr_channels_select on public.msgr_channels;
create policy msgr_channels_select on public.msgr_channels for select to authenticated
  using ((kind = 'public' and public.msgr_role(org_id) in ('owner', 'admin', 'member') and not ((select auth.uid()) = any (excluded_user_ids)))
      or (public.msgr_is_channel_user(id) and public.msgr_is_member(org_id)));

-- 삭제: 관리 권한과 같은 사람. 메시지·구성원·첨부 행은 FK cascade.
drop policy if exists msgr_channels_delete on public.msgr_channels;
create policy msgr_channels_delete on public.msgr_channels for delete to authenticated
  using (public.msgr_can_manage_channel(id));
-- 첨부 파일(저장소 객체)은 DB 트리거로 지우지 않는다(Supabase storage.protect_delete 보호 유지). 앱이 삭제 전에 Storage API로 지우고(조직 관리자 권한),
-- 관리자가 아니면 객체는 남되 채널 행이 없어져 열람 판정(msgr_can_read_channel)이 거짓이라 접근할 수 없다.
drop trigger if exists msgr_channel_purge_storage on public.msgr_channels;
drop function if exists public.msgr_channel_purge_storage();
