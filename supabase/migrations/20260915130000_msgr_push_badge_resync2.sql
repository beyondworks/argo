-- 배지 재동기화 2차(검수 #540 반영). 20260915120000은 라이브에 이미 적용돼 새 파일로.
-- ① 셈법: DM 안읽음 + 나를 멘션한 글 + **내 글에 달린 답글**(푸시 수신자 규칙 msgr_push_recipients와 맞춤 — 답글 알림은 오는데 배지는 0이던 어긋남, M-5).
--    비공개 채널의 일반 글은 세지 않는다(슬랙과 같음 — 배지 = 나를 향한 것).
-- ② 서버 측 제한: 같은 사용자의 재동기화는 5초에 한 번(클라이언트 3초 스로틀만으로는 1계정이 pg_net·엣지·APNs를 증폭할 수 있었다, M-7).
-- ③ 오류는 삼키되 경고를 남긴다(L-4).
-- ④ 읽음 커서는 뒤로 가지 않는다 — 클라이언트 "모두 읽음"이 알림 항목의 글 id로 커서를 올릴 때 더 오래된 id로 되돌리는 사고 방지.
create or replace function public.msgr_push_unread_total(uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(n), 0)::int from (
    select least(99, count(m.id)) as n
    from public.msgr_channels c
    left join public.msgr_reads r on r.channel_id = c.id and r.user_id = uid
    join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null and m.kind = 'text'
         and (m.author_user_id is null or m.author_user_id <> uid)
         and (c.kind = 'dm'
              or m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', uid::text))
              or exists (select 1 from public.msgr_messages p where p.id = m.reply_to and p.author_user_id = uid))
    where c.archived_at is null and (
      (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
      or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    group by c.id
  ) s;
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;

alter table public.msgr_push_tokens add column if not exists badge_sync_at timestamptz;

create or replace function public.msgr_push_badge_resync() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); url text; n int;
begin
  if me is null then return; end if;
  -- 5초 창: 최근 재동기화가 있으면 조용히 끝낸다(행 잠금으로 동시 호출도 하나만)
  update public.msgr_push_tokens t set badge_sync_at = now()
    where t.user_id = me and t.platform = 'ios' and coalesce(t.badge_sync_at, 'epoch'::timestamptz) < now() - interval '5 seconds';
  get diagnostics n = row_count;
  if n = 0 then return; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(),
    body := jsonb_build_object('badge_user', me), timeout_milliseconds := 5000);
exception when others then
  raise warning 'msgr_push_badge_resync: %', sqlerrm;
  return;
end $$;
revoke all on function public.msgr_push_badge_resync() from public, anon;
grant execute on function public.msgr_push_badge_resync() to authenticated;

create or replace function public.msgr_reads_no_regress() returns trigger
language plpgsql as $$
begin
  if new.last_read_id < old.last_read_id then new.last_read_id := old.last_read_id; end if;
  return new;
end $$;
drop trigger if exists msgr_reads_no_regress on public.msgr_reads;
create trigger msgr_reads_no_regress before update on public.msgr_reads for each row execute function public.msgr_reads_no_regress();
