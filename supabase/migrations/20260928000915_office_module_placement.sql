create function public.office_layout_save_v2(p_space text,p_surface text,p_prefs jsonb,p_base_version integer) returns integer
language plpgsql security invoker set search_path=public,pg_temp as $$
declare current_row public.office_user_layouts%rowtype;
begin
 if auth.uid() is null then raise exception 'not signed in' using errcode='42501'; end if;
 if p_space is distinct from 'me' or p_surface is null or p_surface !~ '^[a-z][a-z0-9_-]{0,31}$' or jsonb_typeof(p_prefs) is distinct from 'object' then raise exception 'layout_input' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('office-layout:'||auth.uid()||':'||p_space||':'||p_surface,0));
 select * into current_row from public.office_user_layouts where user_id=auth.uid() and space_key=p_space and surface=p_surface for update;
 if found and current_row.prefs=p_prefs then return current_row.version; end if;
 if p_base_version is distinct from coalesce(current_row.version,0) then raise exception 'layout_version_conflict'; end if;
 insert into public.office_user_layouts as l(user_id,space_key,surface,prefs) values(auth.uid(),p_space,p_surface,p_prefs)
 on conflict(user_id,space_key,surface) do update set prefs=excluded.prefs,version=l.version+1,updated_at=now()
 returning version into current_row.version;
 return current_row.version;
end $$;

create function public.office_space_layout_save_v2(p_org uuid,p_surface text,p_layout jsonb,p_base_version integer) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare current_row public.office_space_layouts%rowtype;
begin
 if public.msgr_is_admin(p_org) is not true then raise exception 'org admin only' using errcode='42501'; end if;
 if p_surface is null or p_surface !~ '^[a-z][a-z0-9_-]{0,31}$' or jsonb_typeof(p_layout) is distinct from 'object' then raise exception 'layout_input' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('office-space-layout:'||p_org||':'||p_surface,0));
 select * into current_row from public.office_space_layouts where org_id=p_org and surface=p_surface for update;
 if found and current_row.layout=p_layout then return current_row.version; end if;
 if p_base_version is distinct from coalesce(current_row.version,0) then raise exception 'layout_version_conflict'; end if;
 insert into public.office_space_layouts as l(org_id,surface,layout,updated_by) values(p_org,p_surface,p_layout,auth.uid())
 on conflict(org_id,surface) do update set layout=excluded.layout,version=l.version+1,updated_at=now(),updated_by=excluded.updated_by
 returning version into current_row.version;
 return current_row.version;
end $$;

create function public.office_page_list_access() returns table(
 id uuid,space_kind text,owner_user_id uuid,org_id uuid,parent_id uuid,"position" text,title text,icon text,restricted boolean,general text,is_template boolean,
 version integer,updated_at timestamptz,archived_at timestamptz,archived_by uuid,access text
)
language sql stable security definer set search_path=public,pg_temp as $$
 select p.id,p.space_kind,p.owner_user_id,p.org_id,p.parent_id,p.position,p.title,p.icon,p.restricted,p.general,p.is_template,
 p.version,p.updated_at,p.archived_at,p.archived_by,public.office_page_access(p.id) from public.office_page_list() p
$$;

create or replace function public.office_strip(n jsonb) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select case
  when n->>'type'='moduleGrid' then '{}'::jsonb
  when jsonb_typeof(n)<>'object' or not(n?'content') or jsonb_typeof(n->'content')<>'array' then n
  else jsonb_set(n,'{content}',coalesce((select jsonb_agg(public.office_strip(c.value) order by c.ord)
   from jsonb_array_elements(n->'content') with ordinality as c(value,ord)
   where coalesce(c.value->>'type','') not in ('recordCard','mailRef','privateBlock','moduleGrid')),'[]'::jsonb))
 end
$$;
revoke all on function public.office_layout_save_v2(text,text,jsonb,integer),public.office_space_layout_save_v2(uuid,text,jsonb,integer),public.office_page_list_access() from public,anon;
grant execute on function public.office_layout_save_v2(text,text,jsonb,integer),public.office_space_layout_save_v2(uuid,text,jsonb,integer),public.office_page_list_access() to authenticated;

create or replace function public.office_space_layout_save(p_org uuid, p_surface text, p_layout jsonb) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public.msgr_is_admin(p_org) is not true then raise exception 'org admin only' using errcode = '42501'; end if;
  insert into public.office_space_layouts as l (org_id, surface, layout, updated_by)
    values (p_org, p_surface, coalesce(p_layout, '{}'::jsonb), auth.uid())
  on conflict (org_id, surface) do update
    set layout = excluded.layout, version = l.version + 1, updated_by = excluded.updated_by, updated_at = now()
    where l.layout is distinct from excluded.layout;
end $$;
