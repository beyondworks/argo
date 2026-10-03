-- 외부 봇이 재사용 첨부를 받는다(2026-10-02 게이트웨이 첨부 재사용 2차 분리 검수 N-1).
-- 배경: 게이트웨이(deliverReplyFiles)가 같은 조직 방에 같은 내용(sha256)을 다시 보낼 때 업로드 없이 첨부 행만 새 글에 만들고,
--   저장 경로는 원본 글의 경로(<org>/<방>/<원본 글>/<키>)를 그대로 쓴다. msgr_bot_file은 경로 3번째 칸 = 그 글 id만 받아
--   재사용 행에 msgr_bot_no_file을 냈다(검수자 임시 PG 재현).
-- 변경: 조직 갈래의 경로 판정만 — 1·2번째 칸(그 글의 조직·방)은 그대로 강제하고, 3번째 칸은 그 글 id이거나
--   (DM 아닌 방의 크루 글일 때) **같은 방의 지워지지 않은 크루 글 중 이 저장 경로의 원본 첨부 행을 가진 글**이면 받는다.
--   다른 방 경로·원본 첨부 행이 없는 경로·사람 글/지운 글 원본·DM 방은 거부한다(3차 검수 F-1).
--   첨부 행 정책(msgr_attachments_insert)이 경로를 묻지 않아 다른 방 경로를 가리키는 행은 만들어질 수 있으므로 방 칸 대조가 경계다.
--   개인 방 갈래는 바꾸지 않는다(개인 방 첨부 행 정책이 그 글 자신의 경로만 받아 재사용이 생기지 않는다).
--   DM 방은 msgr_can_read_dm_attachment도 3번째 칸을 보므로 게이트웨이가 DM에서는 재사용하지 않고(N-2), 여기서도 DM 재사용 행은 받지 않는다.
-- 정의 출처: msgr_bot_file = 20261002140000(가장 최근 정의) 본문 그대로 + 위 판정. 권한(revoke/grant)도 같게 다시 건다.
-- 부하: 3번째 칸이 그 글 id가 아닐 때만 조회 1번(msgr_attachments_storage_path_idx, 20260913122421). 봇 파일 요청 때만 돈다 — 주기 호출 없음.

create or replace function public.msgr_bot_file(token text,attachment uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; a msgr_attachments; s msgr_messages; ch msgr_channels; tw uuid;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 select * into a from msgr_attachments where id=attachment and org_id is null;
 if a.id is not null then -- 개인 방 첨부 — 이 봇의 쌍둥이가 그 방 구성원일 때만, 글 작성자는 명시적 동의(개인 공간 규칙)
   select * into s from msgr_messages where id=a.message_id and deleted_at is null and org_id is null;
   select * into ch from msgr_channels where id=s.channel_id and archived_at is null and org_id is null;
   if s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>'p' or split_part(a.storage_path,'/',2)<>s.channel_id::text or split_part(a.storage_path,'/',3)<>s.id::text then raise exception 'msgr_bot_no_file'; end if;
   tw:=public._msgr_bot_twin(b.id);
   if tw is null then raise exception 'msgr_not_allowed' using detail = 'personal use of this agent needs a reconnect'; end if;
   if not msgr_crew_in_channel(ch.id,tw) then raise exception 'msgr_bot_not_member'; end if;
   -- 개인 배달과 같은 범위 — 주인 글(명시적 동의)·주인 크루 글의 파일만. 친구 글의 파일은 id를 알아도 내주지 않는다(M4)
   if not ((s.author_kind='user' and s.author_user_id=(select owner_user_id from msgr_crews where id=tw) and public.msgr_ai_consent_ok_for(s.author_user_id, true))
        or (s.author_kind='crew' and exists (select 1 from msgr_crews oc where oc.id=s.crew_id and oc.owner_user_id=(select owner_user_id from msgr_crews where id=tw)))) then
     raise exception 'msgr_bot_no_file';
   end if;
   return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
 end if;
 select * into a from msgr_attachments where id=attachment and org_id=b.org_id;
 select * into s from msgr_messages where id=a.message_id and deleted_at is null;
 select * into ch from msgr_channels where id=s.channel_id and archived_at is null;
 if a.id is null or s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>s.org_id::text or split_part(a.storage_path,'/',2)<>s.channel_id::text then raise exception 'msgr_bot_no_file'; end if;
 -- 3번째 칸 = 이 글 id, 또는 재사용 첨부(20261002231000): DM 아닌 방의 크루 글이고, 같은 방의 **지워지지 않은 크루 글**이 이 저장 경로의 원본 첨부 행을 가질 때.
 -- 방 경계는 위 두 칸이 지킨다. 원본을 크루 글로 좁히는 이유(3차 검수 F-1): 첨부 행 정책이 경로를 묻지 않아 구성원이 자기 글에 남의 글 원본 경로를 넣을 수 있다 —
 -- 그 원본이 동의 거부자의 글이거나 지운 글이면 봇이 받으면 안 된다. 게이트웨이 재사용은 크루 답 원본·크루 답 재사용에서만 생긴다.
 -- 원본 작성자 동의 판정은 두지 않는다 — 원본이 크루 글이라 사람 동의 대상이 아니다(아래 동의 판정도 사람 글만 본다).
 if split_part(a.storage_path,'/',3)<>s.id::text and not (ch.kind<>'dm' and s.author_kind='crew' and exists (
      select 1 from msgr_attachments o join msgr_messages om on om.id=o.message_id
       where o.storage_path=a.storage_path and om.channel_id=s.channel_id and om.id::text=split_part(a.storage_path,'/',3)
         and om.author_kind='crew' and om.deleted_at is null)) then raise exception 'msgr_bot_no_file'; end if;
 if ch.kind='dm' then
   if not msgr_crew_in_channel(ch.id,b.crew_id) and not msgr_dm_access(b.crew_id,coalesce(s.thread_root,s.id),false) then raise exception 'msgr_bot_not_member'; end if;
 elsif not msgr_crew_in_channel(ch.id,b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
 -- 검수 L-5(2차 재검수, 선택 적용) — 파일을 올린 글의 작성자가 동의하지 않았으면(거부·철회, 전환 기간 지남) 파일도 감춘다.
 if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then raise exception 'msgr_bot_no_file'; end if;
 return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
end $$;
revoke all on function public.msgr_bot_file(text, uuid) from public;
grant execute on function public.msgr_bot_file(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
