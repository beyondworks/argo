-- 사람 답글의 thread_root는 부모의 뿌리를 따라간다(D38, 검수 발견 2026-09-19).
-- 종전: thread_root가 비어 오면 바로 위 부모(reply_to)로 채웠다. 사람이 앱 [답글]로 크루·봇 글에 답하면 뿌리가
-- 그 크루 글이 되어, msgr_delivery_allowed의 "뿌리가 사람 글" 조건에 막혀 크루가 답글을 받지 못했다
-- (로컬 실측: 답글 1207 reply_to=1204(크루) → thread_root=1204, 배달 대상 t·허용 f. 뿌리를 1203으로 두면 허용 t).
-- 크루·봇 답은 브리지가 뿌리를 직접 넣으므로 사람 답글만 한 칸 어긋나 있었다. 이제 부모의 thread_root(없으면 부모 자신)를 쓴다.
-- 명시한 thread_root는 그대로 둔다. "크루가 먼저 올린 글에 대한 답글" 허용은 정책이라 바꾸지 않는다(뿌리가 크루 글이면 종전처럼 막힌다).
create or replace function public.msgr_message_fill() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare found boolean; parent_root bigint;
begin
  select true, c.org_id into found, new.org_id from public.msgr_channels c where c.id = new.channel_id;
  if not coalesce(found, false) then raise exception 'msgr_channel_missing'; end if;
  if new.reply_to is not null then
    select coalesce(p.thread_root, p.id) into parent_root from public.msgr_messages p where p.id = new.reply_to and p.channel_id = new.channel_id;
    if parent_root is null then raise exception 'msgr_reply_cross_channel'; end if;
  end if;
  if new.thread_root is null then new.thread_root := parent_root; end if;
  return new;
end $$;
