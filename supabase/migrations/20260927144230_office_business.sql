create table public.office_business_customers (
  id uuid primary key default gen_random_uuid(), scope text not null,
  name text not null check (length(name) between 1 and 200), email text not null default '', notes text not null default '',
  version integer not null default 1
);
create table public.office_business_items (
  id uuid primary key default gen_random_uuid(), scope text not null,
  name text not null check (length(name) between 1 and 200), kind text not null check (kind in ('service','product')),
  sku text not null default '', price bigint not null check (price between 0 and 1000000000000),
  stock bigint not null default 0 check (stock >= 0), reserved bigint not null default 0 check (reserved between 0 and stock),
  version integer not null default 1
);
create table public.office_business_orders (
  id uuid primary key default gen_random_uuid(), scope text not null,
  customer_id uuid not null references public.office_business_customers(id), title text not null check (length(title) between 1 and 200),
  status text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  created_at timestamptz not null default clock_timestamp(), confirmed_at timestamptz, cancelled_at timestamptz
);
create table public.office_business_lines (
  id uuid primary key default gen_random_uuid(), scope text not null,
  order_id uuid not null references public.office_business_orders(id), item_id uuid not null references public.office_business_items(id),
  name text not null, kind text not null check (kind in ('service','product')),
  quantity bigint not null check (quantity between 1 and 1000000), unit_price bigint not null check (unit_price between 0 and 1000000000000),
  fulfilled bigint not null default 0 check (fulfilled between 0 and quantity), returned bigint not null default 0 check (returned between 0 and fulfilled)
);
create table public.office_business_entries (
  id uuid primary key default gen_random_uuid(), scope text not null,
  order_id uuid not null references public.office_business_orders(id), kind text not null check (kind in ('invoice','credit','payment','refund')),
  amount bigint not null check (amount between 1 and 1000000000000), at timestamptz not null default clock_timestamp(), note text not null default ''
);
create table public.office_business_movements (
  id uuid primary key default gen_random_uuid(), scope text not null,
  item_id uuid not null references public.office_business_items(id), order_id uuid references public.office_business_orders(id), line_id uuid references public.office_business_lines(id),
  kind text not null check (kind in ('receive','reserve','ship','return','release')), quantity bigint not null check (quantity between 1 and 1000000),
  book_amount bigint not null default 0, at timestamptz not null default clock_timestamp(), note text not null default ''
);
create table public.office_business_settings (
  scope text primary key, enabled jsonb not null default '["customers","catalog","orders","inventory","payments","analytics"]',
  dashboards jsonb not null default '[]', version integer not null default 1
);
create table public.office_business_requests (
  actor uuid not null, key uuid not null, payload jsonb not null, result jsonb not null, primary key(actor,key)
);
create index on public.office_business_customers(scope);
create index on public.office_business_items(scope);
create index on public.office_business_orders(scope,created_at);
create index on public.office_business_lines(order_id);
create index on public.office_business_entries(order_id,at);
create index on public.office_business_movements(scope,at);

do $$ declare tab text; begin
  foreach tab in array array['customers','items','orders','lines','entries','movements','settings','requests'] loop
    execute format('alter table public.%I enable row level security', 'office_business_'||tab);
    execute format('revoke all on public.%I from public, anon, authenticated', 'office_business_'||tab);
  end loop;
end $$;

create function public.office_business_scope(p_org uuid, p_write boolean default false) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); member_role text;
begin
  if who is null then raise exception 'business_forbidden' using errcode='42501'; end if;
  if p_org is null then return 'u:' || who; end if;
  select m.role into member_role from public.msgr_org_members m join public.msgr_orgs o on o.id=m.org_id
    where m.org_id=p_org and m.user_id=who and m.removed_at is null and o.deleted_at is null;
  if member_role is null or member_role='guest' or (p_write and member_role not in ('owner','admin')) then
    raise exception 'business_forbidden' using errcode='42501';
  end if;
  return 'o:' || p_org;
end $$;

create function public.office_business_integer(value jsonb, low bigint, high bigint) returns bigint
language plpgsql immutable set search_path = public, pg_temp as $$
declare result numeric;
begin
  if jsonb_typeof(value) is distinct from 'number' or (value#>>'{}') !~ '^[0-9]+$' then raise exception 'business_number'; end if;
  result := (value#>>'{}')::numeric;
  if result < low or result > high then raise exception 'business_number'; end if;
  return result::bigint;
end $$;

create function public.office_business_write(p_org uuid, p_key uuid, p_action text, p_data jsonb) returns jsonb
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
    if jsonb_array_length(p_data->'enabled')>6 or jsonb_array_length(p_data->'dashboards')>20 or octet_length(p_data::text)>64000 then raise exception 'business_settings'; end if;
    if exists(select 1 from jsonb_array_elements_text(p_data->'enabled') e(value) where value not in ('customers','catalog','orders','inventory','payments','analytics')) then raise exception 'business_settings'; end if;
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
    insert into public.office_business_settings(scope,enabled,dashboards,version) values(sc,p_data->'enabled',p_data->'dashboards',2)
      on conflict(scope) do update set enabled=excluded.enabled,dashboards=excluded.dashboards,version=public.office_business_settings.version+1;
    result_id:=p_key;
  else raise exception 'business_action'; end if;
  insert into public.office_business_requests(actor,key,payload,result) values(who,p_key,payload,jsonb_build_object('id',result_id));
  return jsonb_build_object('id',result_id);
end $$;

create function public.office_business_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); writable boolean; settings jsonb;
begin
  writable:=p_org is null or exists(select 1 from public.msgr_org_members where org_id=p_org and user_id=auth.uid() and removed_at is null and role in ('owner','admin'));
  select jsonb_build_object('enabled',s.enabled,'dashboards',s.dashboards,'version',s.version) into settings from public.office_business_settings s where scope=sc;
  return jsonb_build_object(
    'customers',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.name,r.id),'[]') from public.office_business_customers r where scope=sc),
    'items',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.name,r.id),'[]') from public.office_business_items r where scope=sc),
    'orders',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.created_at,r.id),'[]') from public.office_business_orders r where scope=sc),
    'lines',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.id),'[]') from public.office_business_lines r where scope=sc),
    'entries',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.at,r.id),'[]') from public.office_business_entries r where scope=sc),
    'movements',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.at,r.id),'[]') from public.office_business_movements r where scope=sc),
    'settings',coalesce(settings,'{"enabled":["customers","catalog","orders","inventory","payments","analytics"],"dashboards":[],"version":1}'),
    'can_write',writable,'can_manage',writable);
end $$;

create function public.office_business_report(p_org uuid,p_from date,p_to date,p_customer uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); result jsonb;
begin
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 then raise exception 'business_dates'; end if;
  if p_customer is not null and not exists(select 1 from public.office_business_customers where id=p_customer and scope=sc) then raise exception 'business_not_found'; end if;
  with orders as (
    select * from public.office_business_orders where scope=sc and (p_customer is null or customer_id=p_customer)
  ), events as (
    select o.id order_id,(o.confirmed_at at time zone 'UTC')::date as day,l.kind,l.quantity::numeric*l.unit_price sales,0::numeric invoiced,0::numeric paid
      from orders o join public.office_business_lines l on l.order_id=o.id where o.confirmed_at is not null
    union all
    select o.id,(o.cancelled_at at time zone 'UTC')::date,l.kind,-l.quantity::numeric*l.unit_price,0,0
      from orders o join public.office_business_lines l on l.order_id=o.id where o.cancelled_at is not null and o.confirmed_at is not null
    union all
    select o.id,(m.at at time zone 'UTC')::date,'product',-m.book_amount,0,0
      from orders o join public.office_business_movements m on m.order_id=o.id where m.kind='return'
    union all
    select o.id,(e.at at time zone 'UTC')::date,null,0,
      case when e.kind='invoice' then e.amount when e.kind='credit' then -e.amount else 0 end,
      case when e.kind='payment' then e.amount when e.kind='refund' then -e.amount else 0 end
      from orders o join public.office_business_entries e on e.order_id=o.id
  ), period as (select * from events where day between p_from and p_to),
  grouped as (
    select o.id,o.title,o.customer_id,
      coalesce(sum(e.sales) filter(where e.day>=p_from),0) sales,
      coalesce(sum(e.invoiced) filter(where e.day>=p_from),0) invoiced,
      coalesce(sum(e.paid) filter(where e.day>=p_from),0) paid,
      coalesce(sum(e.invoiced-e.paid),0) receivable
      from orders o join events e on e.order_id=o.id and e.day<=p_to group by o.id,o.title,o.customer_id
  )
  select jsonb_build_object(
    'metrics',jsonb_build_object('sales',coalesce((select sum(sales) from period),0),'invoiced',coalesce((select sum(invoiced) from period),0),'paid',coalesce((select sum(paid) from period),0),
      'receivable',coalesce((select sum(invoiced-paid) from events where day<=p_to),0)),
    'daily',coalesce((select jsonb_agg(to_jsonb(d) order by date) from (select day date,sum(sales) sales,sum(invoiced) invoiced,sum(paid) paid from period group by day) d),'[]'),
    'mix',coalesce((select jsonb_agg(to_jsonb(m) order by kind) from (select kind,sum(sales) amount from period where kind is not null group by kind) m),'[]'),
    'orders',coalesce((select jsonb_agg(to_jsonb(g) order by g.title,g.id) from grouped g),'[]')
  ) into result;
  if exists(select 1 from jsonb_path_query(result,'$.** ? (@.type() == "number")') v where abs((v#>>'{}')::numeric)>9007199254740991) then raise exception 'business_aggregate_limit'; end if;
  return result;
end $$;

revoke all on function public.office_business_scope(uuid,boolean),public.office_business_integer(jsonb,bigint,bigint),
 public.office_business_write(uuid,uuid,text,jsonb),public.office_business_read(uuid),public.office_business_report(uuid,date,date,uuid) from public,anon,authenticated;
grant execute on function public.office_business_write(uuid,uuid,text,jsonb),public.office_business_read(uuid),public.office_business_report(uuid,date,date,uuid) to authenticated;
