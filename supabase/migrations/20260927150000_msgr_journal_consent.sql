-- 3차 재검수(2026-09-27 밤) M-1 — 유건 결정(전환 기간 14일)의 실측 구멍: 거부·철회한 사람의 원문이
-- 크루 "일지" 기억으로 다시 전달됐다. msgr_crew_context는 이미 막았지만(HIGH-1, 20260927140000), 일지는
-- 별개 경로(msgr_channel_journal 트리거 → msgr_org_docs.journal/*.md → msgr_crew_memory)라 안 막혔다.
--
-- 근본 문제: journal/*.md 한 문서는 하루 동안 여러 크루 답글이 한 줄씩 붙어 쌓인 텍스트 블록이다(한 문서 =
-- 여러 사람의 원문 인용 여러 개). 문서 단위 작성자(created_by/updated_by)로는 "이 줄은 누구 글이었나"를
-- 알 수 없어 사후(읽을 때) 재판정이 불가능했다 — 항목3의 "작성자 id 열을 추가" 지시대로 줄 단위 표를 새로 둔다.
--
-- 설계:
--   1) msgr_journal_entries(줄 단위, source_author_id 열) 신설 — 트리거가 msgr_org_docs 쓰기와 같은 트랜잭션에서
--      함께 적는다. msgr_org_docs.journal/*.md(사람이 보는 "채널 기억" 페이지)는 그대로 둔다 — 이건 같은 조직
--      사람끼리는 이미 채널에서 서로의 글을 보므로 별개 문제다. AI(크루)에게 넘기는 msgr_crew_memory만 이 표를
--      쓰도록 바꾼다.
--   2) 적는 시점(트리거)에 원글 작성자가 지금 msgr_ai_consent_visible이 아니면 인용 본문을 "(비공개 / private)"로
--      바꿔서 적는다(항목1) — msgr_org_docs·msgr_journal_entries 둘 다 같은 줄을 쓴다.
--   3) 읽는 시점(msgr_crew_memory)에 msgr_journal_entries를 다시 조인해 지금 동의 상태를 재판정한다(항목2) —
--      적을 때는 동의해서 원문이 그대로 적혔더라도, 그 뒤 철회했으면 읽을 때 빠진다.
--   4) 조직 문서(docs, journal 제외)도 최근 편집자(updated_by)가 거부·철회했으면 뺀다(항목4).
--   5) DB 위생 — msgr_crew_memory는 최근 2일치만 보므로, msgr_journal_entries는 7일 지난 행을 pg_cron
--      (purge-msgr-journal-entries, 03:29)으로 매일 지운다(쓰기 경로의 인라인 삭제는 인덱스를 못 타 델타
--      검수에서 뺐다).
--
-- 알려진 절충(정직하게 표기) — 이 마이그레이션 적용 이전에 쌓인 msgr_org_docs의 옛 journal 텍스트는
-- msgr_journal_entries로 소급 채우지 않는다(한 줄 텍스트에서 작성자 id를 안전하게 복원할 방법이 없다 — 표시
-- 이름 문자열뿐이라 오귀속 위험). msgr_crew_memory가 보는 일지 문맥은 이 마이그레이션 이후의 새 답글부터
-- 다시 쌓인다. msgr_crew_memory는 어차피 최근 2일만 보므로 실사용 영향은 며칠 안에 사라진다.

create table if not exists public.msgr_journal_entries (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  channel_id uuid not null references public.msgr_channels(id) on delete cascade,
  day text not null,
  source_msg_id bigint references public.msgr_messages(id) on delete set null,
  source_author_id uuid references auth.users(id) on delete set null, -- null = 원글이 사람 글이 아님(크루 글 등) — 동의 판정 대상 아님
  line text not null,
  created_at timestamptz not null default now()
);
create index if not exists msgr_journal_entries_lookup on public.msgr_journal_entries (org_id, channel_id, day, id);
create index if not exists msgr_journal_entries_created on public.msgr_journal_entries (created_at); -- 보존 기간 삭제용
-- 델타 검수 LOW(4차) — FK 3개(channel_id·source_msg_id·source_author_id) 각각에 단독 인덱스. org_id는 위
-- lookup 인덱스의 선두 열이라 이미 커버되지만, 나머지 셋은 선두가 아니라 부모 삭제 캐스케이드가 표 전체를 훑는다.
create index if not exists msgr_journal_entries_channel on public.msgr_journal_entries (channel_id);
create index if not exists msgr_journal_entries_source_msg on public.msgr_journal_entries (source_msg_id);
create index if not exists msgr_journal_entries_source_author on public.msgr_journal_entries (source_author_id);
alter table public.msgr_journal_entries enable row level security;
revoke all on public.msgr_journal_entries from public, anon, authenticated; -- msgr_crew_memory(SECURITY DEFINER)로만 읽는다, 쓰기는 트리거뿐

create or replace function public.msgr_channel_journal() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; src msgr_messages; crew_name text; who text; human uuid; day text; line text; src_author uuid; src_visible boolean; quote_body text;
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
  -- 검수 M-1(2026-09-27 밤, 3차 재검수) — 원글 작성자가 지금 동의 상태로 보이지 않으면(거부·철회·전환 기간 지난 미응답)
  -- 일지에 그 사람 원문을 적지 않는다. 크루 글(src.author_kind='crew')은 동의 판정 대상이 아니다(AI 산출물).
  src_author:=case when src.author_kind='user' then src.author_user_id else null end;
  src_visible:=src_author is null or public.msgr_ai_consent_visible(src_author);
  quote_body:=case when not src_visible then '(비공개 / private)' else left(regexp_replace(coalesce(src.body,''),'\s+',' ','g'),160) end;
  day:=to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD'); -- ponytail: 조직 시간대 설정이 생기면 그 값으로
  line:='- '||to_char(now() at time zone 'Asia/Seoul','HH24:MI')||' · **'||coalesce(crew_name,'크루')||'**'
        ||case when who is not null then ' ← '||who||': '||quote_body else '' end
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
  -- 검수 M-1 — msgr_org_docs 쓰기와 별개 예외 범위에 둔다(줄 단위 표 쓰기가 실패해도 방금 성공한 문서 갱신을
  -- 롤백하지 않는다 — 같은 begin/exception 안에 같이 두면 저장점 하나를 공유해 뒤쪽 실패가 앞쪽 성공까지 되돌린다).
  begin
    -- 델타 검수 LOW(4차) — 여기 있던 인라인 삭제(채널당 매 답글)를 뺐다: channel_id 조건만으로는 인덱스를
    -- 못 타 매번 표 전체를 훑었다(msgr_journal_entries_lookup은 org_id가 선두라 channel_id 단독 스캔에
    -- 못 쓰인다). 보존은 아래 03:29 pg_cron(purge-msgr-journal-entries) 하나로만 맡긴다.
    insert into public.msgr_journal_entries(org_id,channel_id,day,source_msg_id,source_author_id,line)
      values(ch.org_id,ch.id,day,src.id,src_author,line);
  exception when others then null; -- 이 표 실패도 답글 저장·문서 갱신을 막지 않는다
  end;
  return new;
end $$;
revoke all on function public.msgr_channel_journal() from public,anon,authenticated;
drop trigger if exists msgr_channel_journal on public.msgr_messages;
create trigger msgr_channel_journal after insert on public.msgr_messages for each row execute function public.msgr_channel_journal();

create or replace function public.msgr_crew_memory(crew uuid, ch uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
    with k as (
      select c.id, c.org_id from public.msgr_crews c
       where c.id = crew and c.owner_user_id = auth.uid() and c.status = 'active'
    ), inch as (
      select exists (select 1 from k join public.msgr_channels x on x.id = ch and x.org_id = k.org_id and x.archived_at is null
                      where public.msgr_crew_in_channel(ch, k.id)) ok
    )
    select case when not exists (select 1 from k) then null else jsonb_build_object(
      'docs', coalesce((select jsonb_agg(jsonb_build_object('scope', x.scope, 'folder', x.folder, 'title', x.title, 'body', x.body) order by x.ord, x.path)
                          from (select case when d.channel_id is null then 'org' else 'channel' end scope, split_part(d.path, '/', 1) folder, d.title, left(d.body, 4000) body, d.path,
                                       case when d.path like 'rules/%' then 0 else 1 end ord -- 규칙 먼저(상한에 잘리지 않게)
                                  from public.msgr_org_docs d, k
                                 where d.org_id = k.org_id and d.path not like 'journal/%'
                                   and ((d.channel_id is null and public.msgr_role(k.org_id) in ('owner', 'admin', 'member'))
                                        or (d.channel_id = ch and (select ok from inch)))
                                   -- 델타 검수 M-1(총괄 결정, 2026-09-27 밤) — rules/ 문서는 사람이 아니라 크루에게 주는 안전·운영
                                   -- 지시라 작성자 동의 여부와 무관하게 항상 넘긴다. 그 밖의 문서(작업 메모 등)는 그대로 거른다.
                                   and (d.path like 'rules/%' or public.msgr_ai_consent_visible(d.updated_by)) -- 검수 M-1 항목4 — 최근 편집자가 거부·철회했으면 문서도 뺀다(rules/ 제외)
                                 order by case when d.path like 'rules/%' then 0 else 1 end, d.channel_id nulls first, d.path limit 20) x), '[]'::jsonb), -- 본문 4,000자·20건 상한(검수 #691 M4)
      -- 검수 M-1(2026-09-27 밤) — msgr_org_docs.journal/*.md는 여러 사람 원문이 한 줄로 뭉친 텍스트라 사후 필터가 안 된다.
      -- msgr_journal_entries(줄 단위 표, 20260927150000)에서 다시 읽어 지금 동의 상태를 매번 판정한다 — 적을 때는 보였지만
      -- 그 뒤 철회한 사람의 줄도 여기서 빠진다. 최근 2일치(날짜 기준)만, 오래된 옛 문맥과 같은 상한(4,000자)을 유지한다.
      'journal', coalesce((select right(string_agg(x.line, E'\n' order by x.id), 4000)
                             from (select je.id, je.line from public.msgr_journal_entries je, k
                                    where je.org_id = k.org_id and je.channel_id = ch and (select ok from inch)
                                      and je.day in (select distinct d2.day from public.msgr_journal_entries d2
                                                       where d2.org_id = k.org_id and d2.channel_id = ch order by d2.day desc limit 2)
                                      and (je.source_author_id is null or public.msgr_ai_consent_visible(je.source_author_id))
                                  ) x), '')
    ) end
$$;
revoke all on function public.msgr_crew_memory(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_memory(uuid, uuid) to authenticated;

-- DB 위생 4항(2026-09-23) — msgr_journal_entries는 누적만 되는 표다. 사람이 보는 원본 일지(msgr_org_docs)와
-- 별개인 AI 읽기 전용 사본이고, msgr_crew_memory도 최근 2일치만 읽으므로 7일 보존이면 충분하다. 원본은 지우지 않는다.
-- 보존은 이 크론 하나로만 맡긴다 — 트리거 안 인라인 삭제는 델타 검수(LOW)로 뺐다(channel_id 단독 조건이
-- msgr_journal_entries_lookup의 선두 열(org_id)을 못 타 크루 답글마다 표 전체를 훑었다).
-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다(20260923220000·20260924160000과 같은 형식).
-- 시각은 기존 purge-cron-run-details(03:17)·purge-msgr-crew-routine-edits(03:23)와 겹치지 않게 03:29.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-msgr-journal-entries', '29 3 * * *',
      $c$delete from public.msgr_journal_entries where created_at < now() - interval '7 days'$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
