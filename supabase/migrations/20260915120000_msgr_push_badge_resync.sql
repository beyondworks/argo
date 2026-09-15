-- 아이콘 배지 재동기화 RPC + 배지 셈법 정정(유건 제보 2026-09-15: "알림 다 읽어도 모바일에서 배지가 안 사라진다").
-- ① 배지는 읽음 커서(msgr_reads)가 바뀔 때만 트리거가 푸시로 내려보냈다. 토큰이 바뀌거나(앱 재설치·TestFlight 갱신 — 라이브 실측: 12:08 토큰 갱신
--    뒤 재계산 푸시 없음) 푸시를 놓치면 폰 숫자가 굳고, 알림함 읽음은 클라이언트 로컬이라 서버 이벤트가 없다. → 앱이 앞으로 올 때·알림함을 열 때
--    클라이언트가 이 RPC를 불러 재계산·재전송(트리거와 같은 경로, 같은 헤더).
-- ② 셈법: 조직 공개 채널의 잡담까지 전부 세던 것을 슬랙처럼 "1:1(DM) 안읽음 + 나를 멘션한 글"로 — 알림함이 보여 주는 것과 배지가 같은 뜻이 된다.
--    (옛 셈법이면 알림을 다 읽어도 공개 채널 안읽음이 남아 배지가 안 내려갔다.)
create or replace function public.msgr_push_unread_total(uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(n), 0)::int from (
    select least(99, count(m.id)) as n
    from public.msgr_channels c
    left join public.msgr_reads r on r.channel_id = c.id and r.user_id = uid
    join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null and m.kind = 'text'
         and (m.author_user_id is null or m.author_user_id <> uid)
         and (c.kind = 'dm' or m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', uid::text)))
    where c.archived_at is null and (
      (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
      or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    group by c.id
  ) s;
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;

create or replace function public.msgr_push_badge_resync() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); url text;
begin
  if me is null then return; end if;
  if not exists (select 1 from public.msgr_push_tokens t where t.user_id = me and t.platform = 'ios') then return; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(),
    body := jsonb_build_object('badge_user', me), timeout_milliseconds := 5000);
exception when others then return;
end $$;
revoke all on function public.msgr_push_badge_resync() from public, anon;
grant execute on function public.msgr_push_badge_resync() to authenticated;
