-- 유건 제보(2026-09-14) 2건.
-- 1) 친구: 같은 조직의 활성 멤버끼리는 요청 없이 바로 친구다. 이미 열려 있는 사람↔사람 1:1 방은 친구로 백필한다(lean8kim이 목록에 없던 사례).
-- 2) 채널 일지: 크루 답글마다 그 채널의 오늘 일지(msgr_org_docs journal/YYYY-MM-DD.md)에 한 줄을 붙인다. 기억 페이지의 "채널의 기억"이 비어 있던 원인 =
--    크루 턴은 로컬 vault 일지에만 남고 클라우드 문서로는 아무 것도 기록되지 않았다. DM·crew_memory=false 채널은 기록하지 않는다.

create or replace function public.msgr_same_org_active(x uuid, y uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from msgr_org_members a join msgr_org_members b on b.org_id=a.org_id
    where a.user_id=x and b.user_id=y and a.removed_at is null and b.removed_at is null
      and (a.expires_at is null or a.expires_at>now()) and (b.expires_at is null or b.expires_at>now()))
$$;
revoke all on function public.msgr_same_org_active(uuid,uuid) from public,anon,authenticated;

create or replace function public.msgr_friend_request(target uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[]; cur public.msgr_friends;
begin
  if me is null then raise exception 'msgr_auth'; end if;
  if target is null or target = me then raise exception 'msgr_friend_self'; end if;
  if not exists (select 1 from auth.users where id = target) then raise exception 'msgr_friend_no_user'; end if;
  pr := public.msgr_friend_pair(me, target);
  select * into cur from public.msgr_friends where a = pr[1] and b = pr[2];
  if cur.status = 'blocked' then raise exception 'msgr_friend_blocked'; end if;
  if cur.status = 'accepted' then return 'friend'; end if;
  if public.msgr_same_org_active(me, target) then -- 같은 조직 동료 = 이미 신뢰 관계. 요청 대기 없이 친구.
    insert into public.msgr_friends (a, b, status, requested_by, decided_at) values (pr[1], pr[2], 'accepted', me, now())
      on conflict (a, b) do update set status = 'accepted', decided_at = now();
    return 'friend';
  end if;
  if exists (select 1 from public.msgr_profiles p where p.user_id = target and not p.accept_requests) then raise exception 'msgr_friend_closed'; end if;
  if cur.a is null then insert into public.msgr_friends (a, b, status, requested_by) values (pr[1], pr[2], 'pending', me); return 'sent'; end if;
  if cur.requested_by = me then return 'sent'; end if;
  update public.msgr_friends set status = 'accepted', decided_at = now() where a = pr[1] and b = pr[2]; return 'friend';
end $$;

-- 백필: 사람 2명·크루 0인 살아 있는 1:1 방의 두 사람은 친구다(같은 조직 활성 멤버일 때만).
insert into public.msgr_friends (a, b, status, requested_by, decided_at)
select p.pr[1], p.pr[2], 'accepted', coalesce(p.created_by, p.pr[1]), p.created_at
from (
  select ch.created_by, ch.created_at, public.msgr_friend_pair((array_agg(m.member_id order by m.member_id))[1], (array_agg(m.member_id order by m.member_id))[2]) pr
  from public.msgr_channels ch join public.msgr_channel_members m on m.channel_id=ch.id and m.member_kind='user'
  where ch.kind='dm' and ch.archived_at is null
    and not exists (select 1 from public.msgr_channel_members c where c.channel_id=ch.id and c.member_kind='crew')
  group by ch.id, ch.created_by, ch.created_at having count(*)=2
) p
where public.msgr_same_org_active(p.pr[1], p.pr[2])
on conflict (a, b) do nothing;

-- 채널 일지 폴더
alter table public.msgr_org_docs drop constraint if exists msgr_org_docs_path_check;
alter table public.msgr_org_docs add constraint msgr_org_docs_path_check check (path ~ '^(rules|glossary|projects|journal)/[a-z0-9][a-z0-9_-]{0,79}\.md$');

-- 일지 갱신은 감사 로그를 남기지 않는다(턴마다 doc.update가 쌓이면 활동 기록이 잡음이 된다 — 일지 문서 자체가 기록).
create or replace function public.msgr_doc_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_org_docs;
begin
  if coalesce(current_setting('argo.msgr_journal', true), '') = '1' then return null; end if;
  r := coalesce(new, old);
  perform public.msgr_audit(r.org_id, 'doc.' || lower(tg_op), 'doc', r.id::text, jsonb_build_object('path', r.path, 'channel_id', r.channel_id, 'version', r.version));
  return null;
end $$;

create or replace function public.msgr_channel_journal() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; src msgr_messages; crew_name text; who text; human uuid; day text; line text;
begin
  if new.author_kind<>'crew' or new.kind<>'text' or new.deleted_at is not null or new.crew_id is null then return new; end if;
  select * into ch from msgr_channels where id=new.channel_id;
  if ch.id is null or ch.kind='dm' or ch.crew_memory=false or ch.archived_at is not null then return new; end if;
  select display_name into crew_name from msgr_crews where id=new.crew_id;
  select * into src from msgr_messages where id=new.reply_to;
  human:=(select author_user_id from msgr_messages where id=coalesce(new.thread_root,new.reply_to) and author_kind='user');
  if human is null then select owner_user_id into human from msgr_crews where id=new.crew_id; end if;
  who:=case when src.author_kind='user' then coalesce((select display_name from msgr_org_members m where m.org_id=ch.org_id and m.user_id=src.author_user_id),'멤버')
            when src.author_kind='crew' then coalesce((select display_name from msgr_crews where id=src.crew_id),'크루') else null end;
  day:=to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD'); -- ponytail: 조직 시간대 설정이 생기면 그 값으로
  line:='- '||to_char(now() at time zone 'Asia/Seoul','HH24:MI')||' · **'||coalesce(crew_name,'크루')||'**'
        ||case when who is not null then ' ← '||who||': '||left(regexp_replace(coalesce(src.body,''),'\s+',' ','g'),160) else '' end
        ||' → '||left(regexp_replace(new.body,'\s+',' ','g'),240);
  begin
    perform set_config('argo.msgr_journal','1',true);
    insert into msgr_org_docs(org_id,channel_id,path,title,body,created_by,updated_by)
    values(ch.org_id,ch.id,'journal/'||day||'.md',day,line,human,human)
    on conflict (org_id, coalesce(channel_id, org_id), path) do update
      set body=left(msgr_org_docs.body||E'\n'||excluded.body,65536), updated_by=excluded.updated_by; -- 하루 64KB를 넘기면 뒤가 잘린다(ponytail: 파일 분할은 필요해지면)
    perform set_config('argo.msgr_journal','',true);
  exception when others then
    perform set_config('argo.msgr_journal','',true); -- 일지 실패가 답글 저장을 막지 않는다
  end;
  return new;
end $$;
revoke all on function public.msgr_channel_journal() from public,anon,authenticated;
drop trigger if exists msgr_channel_journal on public.msgr_messages;
create trigger msgr_channel_journal after insert on public.msgr_messages for each row execute function public.msgr_channel_journal();
notify pgrst,'reload schema';
