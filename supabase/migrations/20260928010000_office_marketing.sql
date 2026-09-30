create table public.office_marketing_campaigns (
 id uuid primary key default gen_random_uuid(), scope text not null, name text not null, channel text not null,
 starts_on date not null, ends_on date not null check(ends_on>=starts_on), budget bigint not null check(budget between 0 and 1000000000000),
 status text not null check(status in ('active','paused','archived')), notes text not null default '', version integer not null default 1
);
create table public.office_marketing_daily (
 id uuid primary key default gen_random_uuid(), scope text not null, campaign_id uuid not null references public.office_marketing_campaigns(id), date date not null,
 spend bigint not null, impressions bigint not null, clicks bigint not null, leads bigint not null,
 source text not null default 'manual' check(source='manual'), version integer not null default 1, unique(campaign_id,date)
);
create table public.office_marketing_goals (
 id uuid primary key default gen_random_uuid(), scope text not null, name text not null, starts_on date not null, ends_on date not null check(ends_on>=starts_on),
 campaign_id uuid references public.office_marketing_campaigns(id), metric text not null check(metric in ('sales','paid','orders')),
 target bigint not null check(target between 1 and 1000000000000), version integer not null default 1
);
create table public.office_marketing_attributions (
 order_id uuid primary key references public.office_business_orders(id), scope text not null,
 campaign_id uuid references public.office_marketing_campaigns(id), version integer not null default 1
);
create table public.office_marketing_history (
 id uuid primary key default gen_random_uuid(), scope text not null, order_id uuid not null references public.office_business_orders(id),
 previous_campaign_id uuid references public.office_marketing_campaigns(id), campaign_id uuid references public.office_marketing_campaigns(id),
 actor uuid not null, at timestamptz not null default clock_timestamp(), version integer not null
);
create index on public.office_marketing_campaigns(scope);
create index on public.office_marketing_daily(scope,date);
create index on public.office_marketing_goals(scope);
create index on public.office_marketing_attributions(scope,campaign_id);
create index on public.office_marketing_history(scope,at);
do $$ declare tab text; begin
 foreach tab in array array['campaigns','daily','goals','attributions','history'] loop
  execute format('alter table public.%I enable row level security','office_marketing_'||tab);
  execute format('revoke all on public.%I from public,anon,authenticated','office_marketing_'||tab);
 end loop;
end $$;

create function public.office_marketing_date(value text) returns date
language plpgsql immutable set search_path=public,pg_temp as $$
declare result date;
begin
 if value is null or value !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'marketing_dates'; end if;
 begin result:=value::date; exception when others then raise exception 'marketing_dates'; end;
 if result::text<>value or result<'1900-01-01'::date or result>'9990-12-31'::date then raise exception 'marketing_dates'; end if;
 return result;
end $$;

create function public.office_marketing_write(p_org uuid,p_key uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
<<marketing_write>>
declare
 sc text:=public.office_business_scope(p_org,true); who uuid:=auth.uid(); receipt public.office_business_requests%rowtype;
 payload jsonb:=jsonb_build_object('domain','marketing','org',p_org,'action',p_action,'data',p_data);
 result_id uuid; campaign_id uuid; old_campaign uuid; current_version integer; start_date date; end_date date;
 row_campaign public.office_marketing_campaigns%rowtype; row_day public.office_marketing_daily%rowtype; row_goal public.office_marketing_goals%rowtype;
begin
 if p_key is null or p_action is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>100000 then raise exception 'marketing_input'; end if;
 perform pg_advisory_xact_lock(hashtextextended('office-business-key:'||who||':'||p_key,0));
 select * into receipt from public.office_business_requests where actor=who and key=p_key;
 if found then
  if receipt.payload<>payload then raise exception 'marketing_idempotency_conflict'; end if;
  return receipt.result;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('office-business-scope:'||sc,0));
 if p_action in ('campaign.save','goal.save') then
  if jsonb_typeof(p_data->'name') is distinct from 'string' or length(trim(p_data->>'name')) not between 1 and 200 then raise exception 'marketing_input'; end if;
  start_date:=public.office_marketing_date(p_data->>'starts_on'); end_date:=public.office_marketing_date(p_data->>'ends_on');
  if end_date<start_date or end_date-start_date>3660 then raise exception 'marketing_dates'; end if;
 end if;
 if p_action='campaign.save' then
  if jsonb_typeof(p_data->'channel') is distinct from 'string' or length(trim(p_data->>'channel')) not between 1 and 100
    or coalesce(p_data->>'status','active') not in ('active','paused','archived') or length(coalesce(p_data->>'notes',''))>10000 then raise exception 'marketing_input'; end if;
  if p_data->>'id' is not null then
   select * into row_campaign from public.office_marketing_campaigns where id=(p_data->>'id')::uuid and scope=sc;
   if not found then raise exception 'marketing_not_found'; end if;
   if row_campaign.version<>public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'marketing_version_conflict'; end if;
   update public.office_marketing_campaigns set name=trim(p_data->>'name'),channel=trim(p_data->>'channel'),starts_on=start_date,ends_on=end_date,
    budget=public.office_business_integer(p_data->'budget',0,1000000000000),status=coalesce(p_data->>'status','active'),notes=coalesce(p_data->>'notes',''),version=version+1 where id=row_campaign.id returning id into result_id;
  else
   insert into public.office_marketing_campaigns(scope,name,channel,starts_on,ends_on,budget,status,notes) values(sc,trim(p_data->>'name'),trim(p_data->>'channel'),start_date,end_date,public.office_business_integer(p_data->'budget',0,1000000000000),coalesce(p_data->>'status','active'),coalesce(p_data->>'notes','')) returning id into result_id;
  end if;
 elsif p_action='daily.save' then
  campaign_id:=(p_data->>'campaign_id')::uuid;
  if not exists(select 1 from public.office_marketing_campaigns c where c.id=marketing_write.campaign_id and c.scope=sc) then raise exception 'marketing_not_found'; end if;
  start_date:=public.office_marketing_date(p_data->>'date');
  if coalesce(p_data->>'source','manual')<>'manual' then raise exception 'marketing_input'; end if;
  if p_data->>'id' is not null then
   select * into row_day from public.office_marketing_daily where id=(p_data->>'id')::uuid and scope=sc;
   if not found then raise exception 'marketing_not_found'; end if;
   if row_day.version<>public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'marketing_version_conflict'; end if;
   if row_day.campaign_id<>campaign_id or row_day.date<>start_date then raise exception 'marketing_input'; end if;
   update public.office_marketing_daily set spend=public.office_business_integer(p_data->'spend',0,1000000000000),impressions=public.office_business_integer(p_data->'impressions',0,1000000000000),clicks=public.office_business_integer(p_data->'clicks',0,1000000000000),leads=public.office_business_integer(p_data->'leads',0,1000000000000),version=version+1 where id=row_day.id returning id into result_id;
  else
   if exists(select 1 from public.office_marketing_daily d where d.campaign_id=marketing_write.campaign_id and d.date=start_date) then raise exception 'marketing_version_conflict'; end if;
   insert into public.office_marketing_daily(scope,campaign_id,date,spend,impressions,clicks,leads) values(sc,campaign_id,start_date,public.office_business_integer(p_data->'spend',0,1000000000000),public.office_business_integer(p_data->'impressions',0,1000000000000),public.office_business_integer(p_data->'clicks',0,1000000000000),public.office_business_integer(p_data->'leads',0,1000000000000)) returning id into result_id;
  end if;
 elsif p_action='goal.save' then
  campaign_id:=(p_data->>'campaign_id')::uuid;
  if campaign_id is not null and not exists(select 1 from public.office_marketing_campaigns c where c.id=marketing_write.campaign_id and c.scope=sc) then raise exception 'marketing_not_found'; end if;
  if coalesce(p_data->>'metric','') not in ('sales','paid','orders') then raise exception 'marketing_input'; end if;
  if p_data->>'id' is not null then
   select * into row_goal from public.office_marketing_goals where id=(p_data->>'id')::uuid and scope=sc;
   if not found then raise exception 'marketing_not_found'; end if;
   if row_goal.version<>public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'marketing_version_conflict'; end if;
   update public.office_marketing_goals set name=trim(p_data->>'name'),starts_on=start_date,ends_on=end_date,campaign_id=marketing_write.campaign_id,metric=p_data->>'metric',target=public.office_business_integer(p_data->'target',1,1000000000000),version=version+1 where id=row_goal.id returning id into result_id;
  else
   insert into public.office_marketing_goals(scope,name,starts_on,ends_on,campaign_id,metric,target) values(sc,trim(p_data->>'name'),start_date,end_date,campaign_id,p_data->>'metric',public.office_business_integer(p_data->'target',1,1000000000000)) returning id into result_id;
  end if;
 elsif p_action='attribution.save' then
  result_id:=(p_data->>'order_id')::uuid; campaign_id:=(p_data->>'campaign_id')::uuid;
  if not exists(select 1 from public.office_business_orders where id=result_id and scope=sc) or (campaign_id is not null and not exists(select 1 from public.office_marketing_campaigns c where c.id=marketing_write.campaign_id and c.scope=sc)) then raise exception 'marketing_not_found'; end if;
  select a.version,a.campaign_id into current_version,old_campaign from public.office_marketing_attributions a where a.order_id=result_id and a.scope=sc;
  if coalesce(current_version,0)<>public.office_business_integer(p_data->'version',0,2147483646) then raise exception 'marketing_version_conflict'; end if;
  insert into public.office_marketing_attributions(scope,order_id,campaign_id,version) values(sc,result_id,campaign_id,coalesce(current_version,0)+1)
   on conflict(order_id) do update set campaign_id=excluded.campaign_id,version=excluded.version;
  insert into public.office_marketing_history(scope,order_id,previous_campaign_id,campaign_id,actor,version) values(sc,result_id,old_campaign,campaign_id,who,coalesce(current_version,0)+1);
 else raise exception 'marketing_input'; end if;
 insert into public.office_business_requests(actor,key,payload,result) values(who,p_key,payload,jsonb_build_object('id',result_id));
 return jsonb_build_object('id',result_id);
end $$;

create function public.office_marketing_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); writable boolean:=true;
begin
 begin perform public.office_business_scope(p_org,true); exception when insufficient_privilege then writable:=false; end;
 return jsonb_build_object(
 'campaigns',coalesce((select jsonb_agg(to_jsonb(c)-'scope' order by c.name,c.id) from public.office_marketing_campaigns c where scope=sc),'[]'),
 'daily',coalesce((select jsonb_agg(to_jsonb(d)-'scope' order by d.date desc,d.id) from public.office_marketing_daily d where scope=sc),'[]'),
 'goals',coalesce((select jsonb_agg(to_jsonb(g)-'scope' order by g.starts_on,g.id) from public.office_marketing_goals g where scope=sc),'[]'),
 'attributions',coalesce((select jsonb_agg(to_jsonb(a)-'scope' order by a.order_id) from public.office_marketing_attributions a where scope=sc),'[]'),
 'history',coalesce((select jsonb_agg(to_jsonb(h)-'scope' order by h.at desc,h.id) from public.office_marketing_history h where scope=sc),'[]'),
 'can_write',writable,'can_manage',writable);
end $$;

create function public.office_marketing_period(p_org uuid,p_from date,p_to date,p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); ledger jsonb; result jsonb;
begin
 ledger:=public.office_business_report(p_org,p_from,p_to,null);
 with campaign_groups as (
  select c.id,c.name,c.channel from public.office_marketing_campaigns c where c.scope=sc and (p_campaign is null or c.id=p_campaign)
  union all select null::uuid,null::text,null::text where p_campaign is null
 ), order_rows as (
  select r.*,a.campaign_id,
   (case when (o.confirmed_at at time zone 'UTC')::date between p_from and p_to then 1 else 0 end
    - case when o.confirmed_at is not null and (o.cancelled_at at time zone 'UTC')::date between p_from and p_to then 1 else 0 end)::numeric order_count
  from jsonb_to_recordset(ledger->'orders') as r(id uuid,title text,customer_id uuid,sales numeric,invoiced numeric,paid numeric,receivable numeric)
   join public.office_business_orders o on o.id=r.id and o.scope=sc
   left join public.office_marketing_attributions a on a.order_id=r.id and a.scope=sc
  where p_campaign is null or a.campaign_id=p_campaign
 ), grouped as (
  select c.id,c.name,c.channel,
   coalesce((select sum(d.spend) from public.office_marketing_daily d where d.scope=sc and d.campaign_id=c.id and d.date between p_from and p_to),0)::numeric spend,
   coalesce((select sum(d.impressions) from public.office_marketing_daily d where d.scope=sc and d.campaign_id=c.id and d.date between p_from and p_to),0)::numeric impressions,
   coalesce((select sum(d.clicks) from public.office_marketing_daily d where d.scope=sc and d.campaign_id=c.id and d.date between p_from and p_to),0)::numeric clicks,
   coalesce((select sum(d.leads) from public.office_marketing_daily d where d.scope=sc and d.campaign_id=c.id and d.date between p_from and p_to),0)::numeric leads,
   coalesce((select sum(r.order_count) from order_rows r where r.campaign_id is not distinct from c.id),0)::numeric orders,
   coalesce((select sum(r.sales) from order_rows r where r.campaign_id is not distinct from c.id),0)::numeric sales,
   coalesce((select sum(r.paid) from order_rows r where r.campaign_id is not distinct from c.id),0)::numeric paid
  from campaign_groups c
 ), totals as (
  select coalesce(sum(spend),0) spend,coalesce(sum(impressions),0) impressions,coalesce(sum(clicks),0) clicks,coalesce(sum(leads),0) leads,
   coalesce(sum(orders),0) orders,coalesce(sum(sales),0) sales,coalesce(sum(paid),0) paid from grouped
 )
 select jsonb_build_object(
  'metrics',(select to_jsonb(t)||jsonb_build_object('roas',sales/nullif(spend,0),'cpl',spend/nullif(leads,0)) from totals t),
  'campaigns',coalesce((select jsonb_agg(to_jsonb(g)||jsonb_build_object('roas',sales/nullif(spend,0),'cpl',spend/nullif(leads,0)) order by g.name nulls last,g.id) from grouped g),'[]'),
  'orders',coalesce((select jsonb_agg(to_jsonb(r)-'order_count' order by r.title,r.id) from order_rows r),'[]')
 ) into result;
 return result;
end $$;

create function public.office_marketing_report(p_org uuid,p_from date,p_to date,p_campaign uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); result jsonb; previous jsonb; goals jsonb:='[]'; goal record; goal_metrics jsonb; actual numeric;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 or p_from<'1900-01-01'::date or p_to>'9990-12-31'::date then raise exception 'marketing_dates'; end if;
 if p_campaign is not null and not exists(select 1 from public.office_marketing_campaigns where scope=sc and id=p_campaign) then raise exception 'marketing_not_found'; end if;
 result:=public.office_marketing_period(p_org,p_from,p_to,p_campaign);
 previous:=public.office_marketing_period(p_org,p_from-(p_to-p_from+1),p_from-1,p_campaign)->'metrics';
 for goal in select * from public.office_marketing_goals where scope=sc and (p_campaign is null or campaign_id=p_campaign) order by starts_on,id loop
  goal_metrics:=public.office_marketing_period(p_org,goal.starts_on,goal.ends_on,goal.campaign_id)->'metrics';
  actual:=(goal_metrics->>goal.metric)::numeric;
  goals:=goals||jsonb_build_array((to_jsonb(goal)-'scope')||jsonb_build_object('actual',actual,'ratio',actual/goal.target));
 end loop;
 result:=result||jsonb_build_object('previous',previous,'goals',goals);
 if exists(select 1 from jsonb_path_query(result,'$.** ? (@.type() == "number")') v where abs((v#>>'{}')::numeric)>9007199254740991) then raise exception 'marketing_aggregate_limit'; end if;
 return result;
end $$;

revoke all on function public.office_marketing_date(text),public.office_marketing_period(uuid,date,date,uuid),public.office_marketing_write(uuid,uuid,text,jsonb),public.office_marketing_read(uuid),public.office_marketing_report(uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.office_marketing_write(uuid,uuid,text,jsonb),public.office_marketing_read(uuid),public.office_marketing_report(uuid,date,date,uuid) to authenticated;

alter table public.office_business_settings add column if not exists performance jsonb not null default '{}'::jsonb;

create or replace function public.office_business_write(p_org uuid, p_key uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
<<business_write>>
declare
  sc text := public.office_business_scope(p_org,true); who uuid := auth.uid(); old_request public.office_business_requests%rowtype;
  payload jsonb := jsonb_build_object('org',p_org,'action',p_action,'data',p_data); result_id uuid;
  customer public.office_business_customers%rowtype; item public.office_business_items%rowtype;
  ord public.office_business_orders%rowtype; ln public.office_business_lines%rowtype; el jsonb; widget jsonb;
  amount bigint; quantity bigint; total numeric; billed numeric; paid numeric; n bigint; k text; ids text[];
begin
  if p_key is null or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text)>100000 then raise exception 'business_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('office-business-key:' || who || ':' || p_key,0));
  select * into old_request from public.office_business_requests where actor=who and key=p_key;
  if found then
    if old_request.payload<>payload then raise exception 'business_idempotency_conflict'; end if;
    return old_request.result;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-business-scope:' || sc,0));
  if p_action in ('customer.save','item.save') then
    if length(trim(coalesce(p_data->>'name',''))) not between 1 and 200 or length(coalesce(p_data->>'notes',''))>10000
       or length(coalesce(p_data->>'email',''))>320 or length(coalesce(p_data->>'sku',''))>100 then raise exception 'business_input'; end if;
    result_id := coalesce((p_data->>'id')::uuid,gen_random_uuid());
    if p_action='customer.save' then
      if p_data->>'id' is not null then
        select * into customer from public.office_business_customers where id=result_id and scope=sc;
        if not found then raise exception 'business_not_found'; end if;
        if customer.version is distinct from public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'business_version_conflict'; end if;
        update public.office_business_customers set name=trim(p_data->>'name'), email=coalesce(p_data->>'email',''), notes=coalesce(p_data->>'notes',''), version=version+1 where id=result_id;
      else
        insert into public.office_business_customers(id,scope,name,email,notes) values(result_id,sc,trim(p_data->>'name'),coalesce(p_data->>'email',''),coalesce(p_data->>'notes',''));
      end if;
    else
      amount := public.office_business_integer(p_data->'price',0,1000000000000);
      if coalesce(p_data->>'kind','') not in ('service','product') then raise exception 'business_kind'; end if;
      if p_data->>'id' is not null then
        select * into item from public.office_business_items where id=result_id and scope=sc;
        if not found then raise exception 'business_not_found'; end if;
        if item.version is distinct from public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'business_version_conflict'; end if;
        if item.kind<>p_data->>'kind' and (item.stock<>0 or exists(select 1 from public.office_business_lines where item_id=result_id)
            or exists(select 1 from public.office_business_movements where item_id=result_id)) then raise exception 'business_kind_in_use'; end if;
        update public.office_business_items set name=trim(p_data->>'name'), kind=p_data->>'kind', sku=coalesce(p_data->>'sku',''), price=amount, version=version+1 where id=result_id;
      else
        insert into public.office_business_items(id,scope,name,kind,sku,price) values(result_id,sc,trim(p_data->>'name'),p_data->>'kind',coalesce(p_data->>'sku',''),amount);
      end if;
    end if;
  elsif p_action='stock.receive' then
    quantity := public.office_business_integer(p_data->'quantity',1,1000000);
    select * into item from public.office_business_items where id=(p_data->>'item_id')::uuid and scope=sc;
    if not found then raise exception 'business_not_found'; end if;
    if item.kind<>'product' then raise exception 'business_product_only'; end if;
    if length(coalesce(p_data->>'note',''))>10000 then raise exception 'business_input'; end if;
    if item.stock>9007199254740991-quantity then raise exception 'business_total_limit'; end if;
    update public.office_business_items set stock=stock+quantity,version=version+1 where id=item.id;
    insert into public.office_business_movements(scope,item_id,kind,quantity,note) values(sc,item.id,'receive',quantity,coalesce(p_data->>'note','')) returning id into result_id;
  elsif p_action='order.create' then
    if length(trim(coalesce(p_data->>'title',''))) not between 1 and 200 or jsonb_typeof(p_data->'lines') is distinct from 'array' then raise exception 'business_input'; end if;
    if jsonb_array_length(p_data->'lines') not between 1 and 100 then raise exception 'business_input'; end if;
    select * into customer from public.office_business_customers where id=(p_data->>'customer_id')::uuid and scope=sc;
    if not found then raise exception 'business_not_found'; end if;
    insert into public.office_business_orders(scope,customer_id,title) values(sc,customer.id,trim(p_data->>'title')) returning id into result_id;
    total:=0;
    for el in select value from jsonb_array_elements(p_data->'lines') loop
      select * into item from public.office_business_items where id=(el->>'item_id')::uuid and scope=sc;
      if not found then raise exception 'business_not_found'; end if;
      quantity:=public.office_business_integer(el->'quantity',1,1000000);
      amount:=public.office_business_integer(el->'unit_price',0,1000000000000);
      total:=total+quantity::numeric*amount;
      if total>1000000000000 then raise exception 'business_total_limit'; end if;
      insert into public.office_business_lines(scope,order_id,item_id,name,kind,quantity,unit_price) values(sc,result_id,item.id,item.name,item.kind,quantity,amount);
    end loop;
  elsif p_action in ('order.confirm','order.cancel','entry.create','line.fulfill','line.return') then
    if p_action in ('line.fulfill','line.return') then
      select * into ln from public.office_business_lines where id=(p_data->>'id')::uuid and scope=sc;
      if not found then raise exception 'business_not_found'; end if;
      result_id:=ln.order_id;
    else result_id:=coalesce((p_data->>'order_id')::uuid,(p_data->>'id')::uuid); end if;
    select * into ord from public.office_business_orders where id=result_id and scope=sc;
    if not found then raise exception 'business_not_found'; end if;
    if p_action='order.confirm' then
      if ord.status<>'draft' then raise exception 'business_order_state'; end if;
      for ln in select * from public.office_business_lines where order_id=ord.id and kind='product' order by item_id,id loop
        update public.office_business_items set reserved=reserved+ln.quantity,version=version+1 where id=ln.item_id and scope=sc and stock-reserved>=ln.quantity;
        if not found then raise exception 'business_insufficient_stock'; end if;
        insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity) values(sc,ln.item_id,ord.id,ln.id,'reserve',ln.quantity);
      end loop;
      update public.office_business_orders set status='confirmed',confirmed_at=clock_timestamp() where id=ord.id;
    elsif p_action='order.cancel' then
      if ord.status='cancelled' or exists(select 1 from public.office_business_lines where order_id=ord.id and fulfilled>0)
        or exists(select 1 from public.office_business_entries where order_id=ord.id) then raise exception 'business_order_state'; end if;
      if ord.status='confirmed' then
        for ln in select * from public.office_business_lines where order_id=ord.id and kind='product' order by item_id,id loop
          update public.office_business_items set reserved=reserved-ln.quantity,version=version+1 where id=ln.item_id;
          insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity) values(sc,ln.item_id,ord.id,ln.id,'release',ln.quantity);
        end loop;
      end if;
      update public.office_business_orders set status='cancelled',cancelled_at=clock_timestamp() where id=ord.id;
    else
      if ord.status<>'confirmed' then raise exception 'business_order_state'; end if;
      if p_action in ('line.fulfill','line.return') then
        quantity:=public.office_business_integer(p_data->'quantity',1,1000000);
        result_id:=ln.id;
        if p_action='line.fulfill' then
          if quantity>ln.quantity-ln.fulfilled then raise exception 'business_quantity'; end if;
          update public.office_business_lines set fulfilled=fulfilled+business_write.quantity where id=ln.id;
          if ln.kind='product' then
            update public.office_business_items set stock=stock-quantity,reserved=reserved-quantity,version=version+1 where id=ln.item_id;
            insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity) values(sc,ln.item_id,ord.id,ln.id,'ship',quantity);
          end if;
        else
          if ln.kind<>'product' or quantity>ln.fulfilled-ln.returned then raise exception 'business_quantity'; end if;
          update public.office_business_lines set returned=returned+business_write.quantity where id=ln.id;
          update public.office_business_items set stock=stock+quantity,version=version+1 where id=ln.item_id;
          insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity,book_amount) values(sc,ln.item_id,ord.id,ln.id,'return',quantity,quantity*ln.unit_price);
        end if;
      else
        k:=p_data->>'kind'; amount:=public.office_business_integer(p_data->'amount',1,1000000000000);
        if k is null or k not in ('invoice','credit','payment','refund') or length(coalesce(p_data->>'note',''))>10000 then raise exception 'business_input'; end if;
        select coalesce(sum((l.quantity-l.returned)::numeric*l.unit_price),0) into total from public.office_business_lines l where l.order_id=ord.id;
        select coalesce(sum(case when e.kind='invoice' then e.amount when e.kind='credit' then -e.amount else 0 end),0),
               coalesce(sum(case when e.kind='payment' then e.amount when e.kind='refund' then -e.amount else 0 end),0)
          into billed,paid from public.office_business_entries e where e.order_id=ord.id;
        if (k='invoice' and amount>total-billed) or (k='credit' and amount>billed) or (k='payment' and amount>billed-paid) or (k='refund' and amount>paid) then raise exception 'business_amount_exceeds_balance'; end if;
        insert into public.office_business_entries(scope,order_id,kind,amount,note) values(sc,ord.id,k,amount,coalesce(p_data->>'note','')) returning id into result_id;
      end if;
    end if;
  elsif p_action='settings.save' then
    select version into n from public.office_business_settings where scope=sc;
    if coalesce(n,1) is distinct from public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'business_version_conflict'; end if;
    if jsonb_typeof(p_data->'enabled') is distinct from 'array' or jsonb_typeof(p_data->'dashboards') is distinct from 'array' then raise exception 'business_settings'; end if;
    if jsonb_array_length(p_data->'enabled')>8 or jsonb_array_length(p_data->'dashboards')>20 or octet_length(p_data::text)>64000 then raise exception 'business_settings'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_data->'enabled') e(value) where value not in ('customers','catalog','orders','inventory','payments','analytics','marketing','performance')) then raise exception 'business_settings'; end if;
    if (select count(*)<>count(distinct value) from jsonb_array_elements_text(p_data->'enabled'))
       or (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(p_data->'dashboards')) then raise exception 'business_settings_duplicate'; end if;
    for el in select value from jsonb_array_elements(p_data->'dashboards') loop
      perform (el->>'id')::uuid;
      if el->>'id' is null or length(trim(coalesce(el->>'name',''))) not between 1 and 100 or jsonb_typeof(el->'widgets') is distinct from 'array'
        or jsonb_typeof(el->'filters') is distinct from 'object' then raise exception 'business_settings'; end if;
      if jsonb_array_length(el->'widgets')>30 then raise exception 'business_settings'; end if;
      if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(el->'widgets')) then raise exception 'business_settings_duplicate'; end if;
      if (el->'filters'->>'from') is null or (el->'filters'->>'to') is null or (el->'filters'->>'from')::date>(el->'filters'->>'to')::date then raise exception 'business_dates'; end if;
      if el->'filters'->>'customer' is not null and not exists(select 1 from public.office_business_customers where id=(el->'filters'->>'customer')::uuid and scope=sc) then raise exception 'business_not_found'; end if;
      for widget in select value from jsonb_array_elements(el->'widgets') loop
        perform (widget->>'id')::uuid;
        if widget->>'id' is null or coalesce(widget->>'type','') not in ('kpi','line','bar','donut','table')
          or coalesce(widget->>'metric','') not in ('sales','invoiced','paid','receivable') or coalesce(widget->>'size','') not in ('s','m','l','full')
          or (widget ? 'hidden' and jsonb_typeof(widget->'hidden') is distinct from 'boolean')
          or (widget->>'type'='donut' and widget->>'metric'<>'sales') or (widget->>'metric'='receivable' and widget->>'type' not in ('kpi','table')) then raise exception 'business_settings'; end if;
      end loop;
    end loop;
    if p_data ? 'performance' then
      el:=p_data->'performance';
      if jsonb_typeof(el) is distinct from 'object' then raise exception 'business_settings'; end if;
      if exists(select 1 from jsonb_object_keys(el) fields(field) where field<>'items') then raise exception 'business_settings'; end if;
      if el ? 'items' then
        if jsonb_typeof(el->'items') is distinct from 'array' then raise exception 'business_settings'; end if;
        if jsonb_array_length(el->'items')>9 then raise exception 'business_settings'; end if;
        if (select count(*)<>count(distinct value->>'id') from jsonb_array_elements(el->'items')) then raise exception 'business_settings_duplicate'; end if;
        for widget in select value from jsonb_array_elements(el->'items') loop
          if jsonb_typeof(widget) is distinct from 'object' then raise exception 'business_settings'; end if;
          if coalesce(widget->>'id','') not in ('spend','sales','paid','roas','cpl','orders','campaigns','comparison','sourceOrders')
            or coalesce(widget->>'size','') not in ('s','m','l','full') or jsonb_typeof(widget->'hidden') is distinct from 'boolean'
            or exists(select 1 from jsonb_object_keys(widget) fields(field) where field not in ('id','size','hidden')) then raise exception 'business_settings'; end if;
        end loop;
      end if;
    end if;
    insert into public.office_business_settings(scope,enabled,dashboards,performance,version) values(sc,p_data->'enabled',p_data->'dashboards',coalesce(p_data->'performance','{}'::jsonb),2)
      on conflict(scope) do update set enabled=excluded.enabled,dashboards=excluded.dashboards,
        performance=case when p_data ? 'performance' then excluded.performance else public.office_business_settings.performance end,
        version=public.office_business_settings.version+1;
    result_id:=p_key;
  else raise exception 'business_action'; end if;
  insert into public.office_business_requests(actor,key,payload,result) values(who,p_key,payload,jsonb_build_object('id',result_id));
  return jsonb_build_object('id',result_id);
end $$;

create or replace function public.office_business_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); writable boolean; settings jsonb;
begin
  writable:=p_org is null or exists(select 1 from public.msgr_org_members where org_id=p_org and user_id=auth.uid() and removed_at is null and role in ('owner','admin'));
  select jsonb_build_object('enabled',s.enabled,'dashboards',s.dashboards,'performance',s.performance,'version',s.version) into settings from public.office_business_settings s where scope=sc;
  return jsonb_build_object(
    'customers',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.name,r.id),'[]') from public.office_business_customers r where scope=sc),
    'items',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.name,r.id),'[]') from public.office_business_items r where scope=sc),
    'orders',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.created_at,r.id),'[]') from public.office_business_orders r where scope=sc),
    'lines',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.id),'[]') from public.office_business_lines r where scope=sc),
    'entries',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.at,r.id),'[]') from public.office_business_entries r where scope=sc),
    'movements',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.at,r.id),'[]') from public.office_business_movements r where scope=sc),
    'settings',coalesce(settings,'{"enabled":["customers","catalog","orders","inventory","payments","analytics","marketing","performance"],"dashboards":[],"performance":{},"version":1}'),
    'can_write',writable,'can_manage',writable);
end $$;


alter table public.office_business_settings alter column enabled set default '["customers","catalog","orders","inventory","payments","analytics","marketing","performance"]'::jsonb;
update public.office_business_settings s set enabled=s.enabled ||
 (select coalesce(jsonb_agg(id),'[]'::jsonb) from (values ('marketing'),('performance')) additions(id) where not s.enabled ? additions.id),version=s.version+1
where not s.enabled ? 'marketing' or not s.enabled ? 'performance';
