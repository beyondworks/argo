-- 유건 제보(2026-09-16) "기억 페이지에 아직도 안 쌓인다": 9/14 이후 크루 답글이 전부 DM에서 났고(5일간 채널 0·DM 45) DM은 일지에서 빠져 있었다.
-- DM도 채널 일지(journal/YYYY-MM-DD.md)에 붙인다. 문서는 channel_id 범위 RLS(msgr_can_read_channel)라 그 DM 참여자만 읽는다 — 조직에 새지 않는다.
-- 소유자 PC로 내려가는 미러(syncOrgDocs)는 journal/을 아예 받지 않도록 같이 바꿨다(크루 프롬프트의 '조직 문서'로 다른 크루에게 새던 길 차단).
-- crew_memory=false·보관 채널 제외는 그대로.
create or replace function public.msgr_channel_journal() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; src msgr_messages; crew_name text; who text; human uuid; day text; line text;
begin
  if new.author_kind<>'crew' or new.kind<>'text' or new.deleted_at is not null or new.crew_id is null then return new; end if;
  select * into ch from msgr_channels where id=new.channel_id;
  if ch.id is null or ch.crew_memory=false or ch.archived_at is not null then return new; end if; -- 2026-09-16: DM 포함(문서는 채널 범위 RLS)
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
notify pgrst,'reload schema';
