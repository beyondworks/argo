-- 읽음 갱신 → 폰 배지 동기화(유건 제보 2026-09-12 "알림은 뜨는데 읽어도 사라지지는 않네"). 어느 기기에서 읽든 msgr_reads 가 바뀌면
-- 엣지 msgr-push 에 {badge_user} 를 보내고, 엣지는 그 사용자의 iOS 토큰에 배지 전용 푸시(aps.badge=안읽음 총계, 알림 없음)를 보낸다.
-- ponytail: 읽음 한 번 = 푸시 한 번(폰 활발히 쓰면 초당 몇 번). 문제되면 pg_net 큐 앞에 1~2초 병합을 둔다.
create or replace function public.msgr_push_badge_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if tg_op = 'UPDATE' and new.last_read_id is not distinct from old.last_read_id then return new; end if;
  if not exists (select 1 from public.msgr_push_tokens t where t.user_id = new.user_id and t.platform = 'ios') then return new; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return new; end if;
  perform net.http_post(url := url, headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('badge_user', new.user_id), timeout_milliseconds := 5000);
  return new;
exception when others then return new;
end $$;
drop trigger if exists msgr_push_badge_sync on public.msgr_reads;
create trigger msgr_push_badge_sync after insert or update on public.msgr_reads for each row execute function public.msgr_push_badge_sync();
