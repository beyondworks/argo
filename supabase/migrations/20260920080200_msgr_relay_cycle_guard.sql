create or replace function public.msgr_dm_relay() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; r msgr_messages; x jsonb; dest uuid; role text; target uuid; via msgr_crews; sent jsonb:='[]'; names text; human uuid; depth int; chain_id bigint; visited jsonb; prior_relay jsonb; cycle boolean;
begin
 if new.kind<>'text' or new.deleted_at is not null or new.author_kind not in ('user','crew') or coalesce(new.meta->>'disposition','')='done' or new.meta ? 'relay' then return new; end if;
 select * into ch from msgr_channels where id=new.channel_id;
 if ch.kind<>'dm' then return new; end if;
 select * into r from msgr_messages where id=coalesce(new.thread_root,new.id);
 human:=case when new.author_kind='user' then new.author_user_id else r.author_user_id end;
 if human is null then return new; end if;
 if new.author_kind='crew' then
   select * into via from msgr_crews where id=new.crew_id;
   prior_relay:=case when jsonb_typeof(r.meta->'relay')='object' then r.meta->'relay' else '{}'::jsonb end;
   depth:=case when prior_relay->>'depth' ~ '^[0-9]+$' then (prior_relay->>'depth')::int else 0 end + 1;
   chain_id:=case when prior_relay->>'chain_id' ~ '^[0-9]+$' then (prior_relay->>'chain_id')::bigint else r.id end;
   visited:=case when jsonb_typeof(prior_relay->'visited_crew_ids')='array' then prior_relay->'visited_crew_ids' else '[]'::jsonb end;
 else
   depth:=1;
   chain_id:=new.id;
   visited:='[]'::jsonb;
 end if;
 for x in select value from jsonb_array_elements(coalesce(new.mentions,'[]')) loop
   if x->>'kind'<>'crew' then continue; end if;
   role:=coalesce(x->>'role','to');
   begin dest:=(x->>'id')::uuid; exception when invalid_text_representation then continue; end;
   if dest is null or msgr_crew_in_channel(ch.id,dest) or (via.id is not null and dest=via.id) then continue; end if;
   cycle:=new.author_kind='crew' and visited @> jsonb_build_array(to_jsonb(dest::text));
   if depth>5 or cycle then
     insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,reply_to,thread_root,client_msg_id,meta)
     values(ch.id,'user',human,'system',case when cycle then '이미 참여한 에이전트에게 다시 전달하려 해 자동 대화를 멈췄습니다. 계속하려면 직접 지시해 주세요.' else '에이전트 사이의 전달이 5단계를 넘어 멈췄습니다. 필요하면 직접 지시해 주세요.' end,new.id,r.id,'relaycap:'||new.id,jsonb_build_object('relay_capped',depth,'relay_cycle',cycle,'relay_chain_id',chain_id))
     on conflict do nothing;
     return new;
   end if;
   begin
     target:=msgr_dm_for_crew(ch.org_id,human,dest);
     if target is null or target=ch.id then continue; end if;
     insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
     values(target,'user',human,'text',new.body,jsonb_build_array(jsonb_build_object('kind','crew','id',dest,'role',role)),'relay:'||new.id||':'||dest,
       jsonb_build_object('relay',jsonb_build_object('source_id',new.id,'channel_id',ch.id,'role',role,'via_crew_id',via.id,'via_name',via.display_name,'depth',depth,'chain_id',chain_id,'visited_crew_ids',visited || jsonb_build_array(to_jsonb(dest::text)))))
     on conflict do nothing;
     sent:=sent||jsonb_build_object('crew_id',dest,'channel_id',target,'role',role,'name',(select display_name from msgr_crews where id=dest));
   exception when others then
     sent:=sent||jsonb_build_object('crew_id',dest,'channel_id',null,'role',role,'name',(select display_name from msgr_crews where id=dest),'failed',sqlerrm);
   end;
 end loop;
 if jsonb_array_length(sent)=0 then return new; end if;
 select string_agg(e->>'name'||case when e->>'role'='cc' then '(참조)' else '' end||case when e ? 'failed' then ' — 전달 실패' else '' end,', ' order by (e->>'role'='cc'),e->>'name') into names from jsonb_array_elements(sent) e;
 insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,reply_to,thread_root,client_msg_id,meta)
 values(ch.id,'user',human,'system',names||'에게 전달했습니다. 답변은 그 에이전트와의 1:1 대화에 올라옵니다.',new.id,r.id,'relaynote:'||new.id,jsonb_build_object('relay_to',sent))
 on conflict do nothing;
 return new;
end $$;

revoke all on function public.msgr_dm_relay() from public,anon,authenticated;
notify pgrst,'reload schema';
