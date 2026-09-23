-- 조직·채널 기억 연결(유건 결정 2026-09-24, 설계 P3): [[ ]] 링크와 업무 맥락(같은 참여자·같은 부서)으로 관련 기억을 잇는다.
-- 링크는 두 문서를 모두 읽을 수 있는 사람에게만 보인다(RLS가 문서 정책을 그대로 재사용). 기억 데이터라 지우지 않는다(DB 위생 규칙 1).
-- 계산은 답글 트리거가 아니라 커서 기반 일괄 작업 — 답글 저장을 막거나 느리게 하지 않는다(설계 검수 H6). 같은 링크는 다시 쓰지 않는다.

-- 부서·직급: 조직 관리자가 입력한다(본인 수정 불가). 에이전트는 부서만(주인이 크루 카드에서).
alter table public.msgr_org_members add column if not exists department text check (department is null or length(department) between 1 and 60),
                                    add column if not exists title text check (title is null or length(title) between 1 and 60);
alter table public.msgr_crews add column if not exists department text check (department is null or length(department) between 1 and 60);

create or replace function public.msgr_member_profile_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 서비스 문맥(auth.uid() null)은 통과. 사용자는 조직 관리자만 부서·직급을 바꾼다.
  if auth.uid() is not null and (new.department is distinct from old.department or new.title is distinct from old.title)
     and not coalesce(public.msgr_is_admin(old.org_id), false) then
    raise exception 'msgr_member_profile_forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists msgr_member_profile_guard on public.msgr_org_members;
create trigger msgr_member_profile_guard before update on public.msgr_org_members for each row execute function public.msgr_member_profile_guard();

-- 관리자가 멤버의 부서·직급을 정한다(표 update 정책은 본인 표시명만이라 RPC로).
create or replace function public.msgr_set_member_profile(org uuid, member uuid, dept text, job text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(public.msgr_is_admin(org), false) then raise exception 'msgr_member_profile_forbidden' using errcode = '42501'; end if;
  update public.msgr_org_members set department = nullif(btrim(dept), ''), title = nullif(btrim(job), '')
   where org_id = org and user_id = member and removed_at is null
     and (department is distinct from nullif(btrim(dept), '') or title is distinct from nullif(btrim(job), ''));
end $$;
revoke all on function public.msgr_set_member_profile(uuid, uuid, text, text) from public, anon;
grant execute on function public.msgr_set_member_profile(uuid, uuid, text, text) to authenticated;

create table if not exists public.msgr_doc_links (
  src_doc uuid not null references public.msgr_org_docs (id) on delete cascade,
  dst_doc uuid not null references public.msgr_org_docs (id) on delete cascade,
  reason text not null check (reason in ('wikilink', 'people', 'department')),
  created_at timestamptz not null default now(),
  primary key (src_doc, dst_doc),
  check (src_doc <> dst_doc)
);
create index if not exists msgr_doc_links_dst on public.msgr_doc_links (dst_doc);
alter table public.msgr_doc_links enable row level security;
grant select on public.msgr_doc_links to authenticated;
grant all on public.msgr_doc_links to service_role;
drop policy if exists msgr_doc_links_select on public.msgr_doc_links;
create policy msgr_doc_links_select on public.msgr_doc_links for select to authenticated
  using (exists (select 1 from public.msgr_org_docs d where d.id = src_doc) and exists (select 1 from public.msgr_org_docs d where d.id = dst_doc));

create table if not exists public.msgr_doc_link_state (
  id int primary key default 1 check (id = 1),
  cursor_at timestamptz not null default '-infinity',
  cursor_id uuid not null default '00000000-0000-0000-0000-000000000000'
);
insert into public.msgr_doc_link_state (id) values (1) on conflict do nothing;
revoke all on public.msgr_doc_link_state from public, anon, authenticated;

-- 채널의 사람(조직장·조직 관리자 제외 — 거의 모든 채널에 있어 모든 기억을 서로 잇게 된다. ponytail: 채널 수 비율 기준이 필요해지면 교체)
create or replace function public.msgr_channel_people(ch uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select m.member_id from public.msgr_channel_members m join public.msgr_channels c on c.id = m.channel_id
      join public.msgr_org_members om on om.org_id = c.org_id and om.user_id = m.member_id and om.removed_at is null and om.role in ('member', 'guest')
     where m.channel_id = ch and m.member_kind = 'user'
$$;
revoke all on function public.msgr_channel_people(uuid) from public, anon, authenticated;

-- 일괄 연결: 커서 뒤 갱신된 문서마다 ① 본문의 [[제목]](닫는 괄호까지 일치) ② 사람·부서가 겹치는 다른 채널의 최신 문서 상위 3건(채널당 1건).
-- 신호가 하나도 없으면 잇지 않는다(내용 유사도만으로는 안 잇는다 — 유건 결정 5). 처리한 문서가 없으면 아무것도 쓰지 않는다.
-- 임시 표는 pg_temp.로만 부른다 — search_path가 public 먼저라 같은 이름의 public 표가 있으면 그쪽을 쓴다(재검 #691 LOW).
-- 비용(검수 #691 M3): 채널 쌍 점수는 호출마다 채널별로 한 번만 계산해 임시 표에 두고, 7일 넘은 일지는 원천·대상 모두에서 뺀다
-- (일지는 답글마다 updated_at이 바뀌어 활동 채널의 오늘 일지만 다시 계산된다). 부하: 문서 200건·채널 N개면 채널 쌍 계산 최대 200×N회 → 채널 단위 캐시로 (배치 안 채널 수)×N.
create or replace function public.msgr_doc_links_refresh(lim int default 200) returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare d record; st record; n int := 0; pa uuid[]; da text[];
begin
  select * into st from public.msgr_doc_link_state where id = 1;
  if not exists (select 1 from public.msgr_org_docs x where (x.updated_at, x.id) > (st.cursor_at, st.cursor_id)) then return 0; end if; -- 10분마다 도는 cron — 할 일 없으면 임시 표도 안 만든다
  create temp table if not exists msgr_dl_scores (a uuid, b uuid, score int, reason text) on commit drop;
  truncate pg_temp.msgr_dl_scores;
  for d in select x.id, x.org_id, x.channel_id, x.body, x.path, x.updated_at from public.msgr_org_docs x
            where (x.updated_at, x.id) > (st.cursor_at, st.cursor_id) order by x.updated_at, x.id limit greatest(1, least(coalesce(lim, 200), 1000)) loop
    st.cursor_at := d.updated_at; st.cursor_id := d.id; n := n + 1;
    if d.path like 'journal/%' and d.updated_at < now() - interval '7 days' then continue; end if;
    insert into public.msgr_doc_links (src_doc, dst_doc, reason)
      select d.id, o.id, 'wikilink' from public.msgr_org_docs o
       where o.org_id = d.org_id and o.id <> d.id and position('[[' || o.title || ']]' in d.body) > 0
      on conflict do nothing;
    if d.channel_id is null then continue; end if;
    if not exists (select 1 from pg_temp.msgr_dl_scores where a = d.channel_id) then
      pa := array(select public.msgr_channel_people(d.channel_id));
      da := array(select distinct m.department from public.msgr_org_members m where m.org_id = d.org_id and m.department is not null and m.user_id = any (pa));
      insert into pg_temp.msgr_dl_scores (a, b, score, reason)
        select d.channel_id, c.id, p.shared * 2 + p.depts, case when p.shared > 0 then 'people' else 'department' end
          from public.msgr_channels c
          cross join lateral (
            select cardinality(array(select unnest(pa) intersect select public.msgr_channel_people(c.id))) shared,
                   (select count(distinct m.department) from public.msgr_org_members m
                     where m.org_id = d.org_id and m.department = any (da) and m.user_id in (select public.msgr_channel_people(c.id))) depts
          ) p
         where c.org_id = d.org_id and c.id <> d.channel_id and c.kind in ('public', 'private') and (p.shared > 0 or p.depts > 0);
      insert into pg_temp.msgr_dl_scores (a, b, score, reason) values (d.channel_id, null, 0, null); -- 계산함 표지(점수 0건이어도 다시 안 센다)
    end if;
    insert into public.msgr_doc_links (src_doc, dst_doc, reason)
      select d.id, t.id, t.reason from (
        select distinct on (s.b) o.id, s.reason, s.score, o.updated_at
          from pg_temp.msgr_dl_scores s join public.msgr_org_docs o on o.channel_id = s.b
         where s.a = d.channel_id and s.b is not null and not (o.path like 'journal/%' and o.updated_at < now() - interval '7 days')
         order by s.b, o.updated_at desc
      ) t order by t.score desc, t.updated_at desc limit 3
      on conflict do nothing;
  end loop;
  if n > 0 then update public.msgr_doc_link_state set cursor_at = st.cursor_at, cursor_id = st.cursor_id where id = 1; end if;
  return n;
end $$;
revoke all on function public.msgr_doc_links_refresh(int) from public, anon, authenticated;

-- 기억 화면용 — 이 조직 문서에서 나가는 링크만(표 전체를 RLS로 훑지 않게, 검수 #691 M5). 호출자 권한(invoker)이라 문서·링크 RLS가 그대로 걸린다.
create or replace function public.msgr_doc_links_for(org uuid) returns table (src_doc uuid, dst_doc uuid, reason text)
  language sql stable set search_path = public, pg_temp as $$
    select l.src_doc, l.dst_doc, l.reason from public.msgr_doc_links l join public.msgr_org_docs s on s.id = l.src_doc
     where s.org_id = org limit 2000
$$;
revoke all on function public.msgr_doc_links_for(uuid) from public, anon;
grant execute on function public.msgr_doc_links_for(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr-doc-links-refresh', '*/10 * * * *', $c$select public.msgr_doc_links_refresh(200)$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
