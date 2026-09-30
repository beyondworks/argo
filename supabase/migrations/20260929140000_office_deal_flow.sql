-- 거래 흐름(유건 9/29): 부가세 분리·칸반 단계·거래처 강화·부분 가림·카드 자료.
-- 단계는 따로 저장하지 않는다 — 확정 여부와 청구·입금 장부에서 계산한다(단계와 장부가 어긋날 일이 없다).
--   견적 = draft, 계약 = confirmed·청구 없음, 계산서 발행 = 청구 있음·잔액 남음, 입금 완료 = 청구 = 입금 = 총액, 취소 = cancelled
-- 금액: 매출은 공급가액, 청구·입금·미수금은 부가세 포함(실제 오가는 돈). 청구 기록에 공급가액·세액을 나눠 남긴다(세금 업무용).

alter table public.office_business_customers
  add column ceo text not null default '' check (length(ceo)<=100),
  add column biz_no text not null default '' check (biz_no ~ '^[0-9-]{0,20}$'),
  add column manager text not null default '' check (length(manager)<=100),
  add column phone text not null default '' check (length(phone)<=50),
  add column address text not null default '' check (length(address)<=500),
  add column account text not null default '' check (length(account)<=200),
  add column category text not null default 'customer' check (category in ('customer','partner')),
  add column status text not null default 'active' check (status in ('active','hold','closed')),
  add column redacted text[] not null default '{}';
alter table public.office_business_orders add column redacted text[] not null default '{}',
  -- 들어온 경로(유건 9/29: 마케팅을 안 하는 사업도 쓴다) — 비우면 모름. 소개면 소개한 거래처·사람
  add column source text check (source in ('referral','returning','inbound','search_sns','other','campaign')),
  add column referrer_customer_id uuid references public.office_business_customers(id),
  add column referrer_name text not null default '' check (length(referrer_name)<=100);
alter table public.office_business_lines
  add column tax_type text not null default 'taxable' check (tax_type in ('taxable','zero','exempt')),
  add column vat bigint not null default 0 check (vat between 0 and 1000000000000);
alter table public.office_business_entries
  add column supply bigint check (supply between 0 and 1000000000000),
  add column vat bigint check (vat between 0 and 1000000000000);

-- 부가세 도입 전 거래는 세액 0 그대로 둔다 — 줄에 10%를 채우면 이미 정산된 거래가 미수금 있음으로 되돌아가고 추가 청구가 열린다(분리 검수 HIGH).
-- 기존 청구도 공급가액 = 금액, 세액 0.
update public.office_business_entries set supply=amount,vat=0 where kind in ('invoice','credit') and supply is null;

-- 카드 자료: 거래를 따라 다니는 페이지·메일·파일·메모
create table public.office_business_links (
  id uuid primary key default gen_random_uuid(), scope text not null,
  order_id uuid not null references public.office_business_orders(id),
  kind text not null check (kind in ('page','mail','file','note')), ref text not null default '', title text not null default '', body text not null default '',
  created_at timestamptz not null default clock_timestamp(), created_by uuid
);
-- 카드 기록: 단계 이동·되돌리기·청구·입금·취소. 거래 이력이라 보존한다(정리 대상 아님).
create table public.office_business_activity (
  id uuid primary key default gen_random_uuid(), scope text not null,
  order_id uuid not null references public.office_business_orders(id),
  kind text not null check (kind in ('quote','contract','reopen','invoice','credit','payment','refund','cancel')),
  at timestamptz not null, actor uuid, amount bigint, note text not null default ''
);
create index on public.office_business_links(order_id);
create index on public.office_business_links(scope);
create index on public.office_business_activity(scope,at);
alter table public.office_business_links enable row level security;
alter table public.office_business_activity enable row level security;
revoke all on public.office_business_links from public, anon, authenticated;
revoke all on public.office_business_activity from public, anon, authenticated;

-- 기존 거래의 기록을 채운다(견적·계약·청구·입금·취소 시각은 이미 장부에 있다)
insert into public.office_business_activity(scope,order_id,kind,at)
  select scope,id,'quote',created_at from public.office_business_orders
  union all select scope,id,'contract',confirmed_at from public.office_business_orders where confirmed_at is not null
  union all select scope,id,'cancel',cancelled_at from public.office_business_orders where cancelled_at is not null;
insert into public.office_business_activity(scope,order_id,kind,at,amount) select scope,order_id,kind,at,amount from public.office_business_entries;

-- 단계 날짜: 비우면 지금, 고치면 그 날짜. 날짜만 주면 오늘은 지금 시각(오늘 만든 견적을 오늘 계약해도 순서가 맞게), 지난 날은 한국 시각 정오
-- (날짜 경계에서 하루 밀리지 않게). 20년 전 ~ 내일까지만.
create or replace function public.office_business_at(value jsonb) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
declare result timestamptz;
begin
  if value is null or jsonb_typeof(value)='null' then return clock_timestamp(); end if;
  if jsonb_typeof(value)<>'string' then raise exception 'business_dates'; end if;
  begin
    result:=case when (value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then (value#>>'{}')::timestamptz
      when (value#>>'{}')::date=(clock_timestamp() at time zone 'Asia/Seoul')::date then clock_timestamp()
      else ((value#>>'{}')||' 12:00:00+09')::timestamptz end;
  exception when others then raise exception 'business_dates'; end;
  if result<clock_timestamp()-interval '20 years'
    or ((value#>>'{}') ~ '^\d{4}-\d{2}-\d{2}$' and (value#>>'{}')::date>(clock_timestamp() at time zone 'Asia/Seoul')::date+1)
    or ((value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' and result>clock_timestamp()+interval '1 day') then raise exception 'business_dates'; end if;
  return result;
end $$;

-- 과세 10%, 원 미만 절사. 영세율·면세는 0.
create function public.office_business_vat(supply numeric, tax_type text) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case when tax_type='taxable' then floor(supply/10)::bigint else 0::bigint end
$$;

-- 마케팅·성과 분석은 광고하는 사람만 켠다(유건 9/29) — 새 공간 기본값에서 빼고, 광고 기록이 없는 기존 공간도 끈다
alter table public.office_business_settings alter column enabled set default '["customers","catalog","orders","inventory","payments","analytics"]'::jsonb;
update public.office_business_settings s set enabled=s.enabled-'marketing'-'performance',version=s.version+1
 where (s.enabled ? 'marketing' or s.enabled ? 'performance')
   and not exists(select 1 from public.office_marketing_campaigns c where c.scope=s.scope)
   and not exists(select 1 from public.office_marketing_daily d where d.scope=s.scope)
   and not exists(select 1 from public.office_marketing_goals g where g.scope=s.scope); -- 목표만 세운 공간도 켠 채로 둔다(분리 검수 2차)
-- 성과 분석은 마케팅 탭으로 합쳤다(유건 9/29) — 성과 분석만 켜 둔 공간은 마케팅을 켜서 같은 숫자를 계속 보게 한다
update public.office_business_settings s set enabled=s.enabled||'["marketing"]'::jsonb,version=s.version+1 where s.enabled ? 'performance' and not s.enabled ? 'marketing';
-- 이미 캠페인에 연결된 거래는 들어온 경로도 캠페인으로(분리 검수 M5) — 경로 칸·경로별 매출과 마케팅 탭이 같은 사실을 보이게
update public.office_business_orders o set source='campaign' from public.office_marketing_attributions a
 where a.order_id=o.id and a.scope=o.scope and a.campaign_id is not null and o.source is null;

create or replace function public.office_business_write(p_org uuid, p_key uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
<<business_write>>
declare
  sc text := public.office_business_scope(p_org,true); who uuid := auth.uid(); old_request public.office_business_requests%rowtype;
  payload jsonb := jsonb_build_object('org',p_org,'action',p_action,'data',p_data); result_id uuid;
  customer public.office_business_customers%rowtype; item public.office_business_items%rowtype;
  ord public.office_business_orders%rowtype; ln public.office_business_lines%rowtype; el jsonb; widget jsonb;
  amount bigint; quantity bigint; total numeric; billed numeric; paid numeric; n bigint; k text; ids text[];
  at_ts timestamptz; vat bigint; supply bigint; gross numeric; gross_vat numeric; tax text; f text; on_off boolean; lk public.office_business_links%rowtype; mk_campaign uuid;
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
    if p_action='customer.save' and (length(coalesce(p_data->>'ceo',''))>100 or length(coalesce(p_data->>'manager',''))>100 or length(coalesce(p_data->>'phone',''))>50
       or length(coalesce(p_data->>'address',''))>500 or length(coalesce(p_data->>'account',''))>200 or coalesce(p_data->>'biz_no','') !~ '^[0-9-]{0,20}$'
       or coalesce(p_data->>'category','customer') not in ('customer','partner') or coalesce(p_data->>'status','active') not in ('active','hold','closed')) then raise exception 'business_input'; end if;
    result_id := coalesce((p_data->>'id')::uuid,gen_random_uuid());
    if p_action='customer.save' then
      if p_data->>'id' is not null then
        select * into customer from public.office_business_customers where id=result_id and scope=sc;
        if not found then raise exception 'business_not_found'; end if;
        if customer.version is distinct from public.office_business_integer(p_data->'version',1,2147483646) then raise exception 'business_version_conflict'; end if;
        update public.office_business_customers set name=trim(p_data->>'name'), email=coalesce(p_data->>'email',''), notes=coalesce(p_data->>'notes',''),
          ceo=coalesce(p_data->>'ceo',''), biz_no=coalesce(p_data->>'biz_no',''), manager=coalesce(p_data->>'manager',''), phone=coalesce(p_data->>'phone',''),
          address=coalesce(p_data->>'address',''), account=coalesce(p_data->>'account',''), category=coalesce(p_data->>'category','customer'), status=coalesce(p_data->>'status','active'),
          version=version+1 where id=result_id;
      else
        insert into public.office_business_customers(id,scope,name,email,notes,ceo,biz_no,manager,phone,address,account,category,status)
          values(result_id,sc,trim(p_data->>'name'),coalesce(p_data->>'email',''),coalesce(p_data->>'notes',''),coalesce(p_data->>'ceo',''),coalesce(p_data->>'biz_no',''),
            coalesce(p_data->>'manager',''),coalesce(p_data->>'phone',''),coalesce(p_data->>'address',''),coalesce(p_data->>'account',''),
            coalesce(p_data->>'category','customer'),coalesce(p_data->>'status','active'));
        if p_data ? 'redacted' then
          if jsonb_typeof(p_data->'redacted') is distinct from 'array' or exists(select 1 from jsonb_array_elements_text(p_data->'redacted') r(field) where field not in ('email','ceo','biz_no','manager','phone','address','account','notes'))
            then raise exception 'business_input'; end if;
          update public.office_business_customers set redacted=array(select distinct jsonb_array_elements_text(p_data->'redacted')) where id=result_id;
        end if;
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
    at_ts:=public.office_business_at(p_data->'at');
    insert into public.office_business_orders(scope,customer_id,title,created_at) values(sc,customer.id,trim(p_data->>'title'),at_ts) returning id into result_id;
    insert into public.office_business_activity(scope,order_id,kind,at,actor) values(sc,result_id,'quote',at_ts,who);
    total:=0;
    for el in select value from jsonb_array_elements(p_data->'lines') loop
      select * into item from public.office_business_items where id=(el->>'item_id')::uuid and scope=sc;
      if not found then raise exception 'business_not_found'; end if;
      quantity:=public.office_business_integer(el->'quantity',1,1000000);
      amount:=public.office_business_integer(el->'unit_price',0,1000000000000);
      tax:=coalesce(el->>'tax_type','taxable');
      if tax not in ('taxable','zero','exempt') then raise exception 'business_input'; end if;
      vat:=case when el ? 'vat' then public.office_business_integer(el->'vat',0,1000000000000) else public.office_business_vat(quantity::numeric*amount,tax) end;
      if (tax<>'taxable' and vat<>0) or vat>public.office_business_vat(quantity::numeric*amount,'taxable')+10 then raise exception 'business_input'; end if; -- 직접 준 세액은 10% + 반올림 여유 10원까지(분리 검수: 오타가 청구 한도를 늘린다)
      total:=total+quantity::numeric*amount+vat;
      if total>1000000000000 then raise exception 'business_total_limit'; end if;
      insert into public.office_business_lines(scope,order_id,item_id,name,kind,quantity,unit_price,tax_type,vat) values(sc,result_id,item.id,item.name,item.kind,quantity,amount,tax,vat);
    end loop;
  elsif p_action in ('order.confirm','order.cancel','order.reopen','entry.create','line.fulfill','line.return','line.tax','link.add','order.source') then
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
      at_ts:=public.office_business_at(p_data->'at');
      if at_ts<ord.created_at then raise exception 'business_dates'; end if;
      update public.office_business_orders set status='confirmed',confirmed_at=at_ts where id=ord.id;
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'contract',at_ts,who,coalesce(p_data->>'note',''));
    elsif p_action='order.reopen' then
      -- 계약 → 견적 되돌리기: 청구·출고가 아직 없을 때만(장부를 지우지 않는다)
      if ord.status<>'confirmed' or exists(select 1 from public.office_business_lines where order_id=ord.id and fulfilled>0)
        or exists(select 1 from public.office_business_entries where order_id=ord.id) then raise exception 'business_order_state'; end if;
      for ln in select * from public.office_business_lines where order_id=ord.id and kind='product' order by item_id,id loop
        update public.office_business_items set reserved=reserved-ln.quantity,version=version+1 where id=ln.item_id;
        insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity) values(sc,ln.item_id,ord.id,ln.id,'release',ln.quantity);
      end loop;
      update public.office_business_orders set status='draft',confirmed_at=null where id=ord.id;
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'reopen',clock_timestamp(),who,coalesce(p_data->>'note',''));
    elsif p_action='line.tax' then
      -- 과세 구분·세액 고치기: 청구 전(견적·계약)까지만
      if ord.status='cancelled' or exists(select 1 from public.office_business_entries where order_id=ord.id) then raise exception 'business_order_state'; end if;
      select * into ln from public.office_business_lines where id=(p_data->>'line_id')::uuid and order_id=ord.id;
      if not found then raise exception 'business_not_found'; end if;
      tax:=coalesce(p_data->>'tax_type','taxable');
      if tax not in ('taxable','zero','exempt') then raise exception 'business_input'; end if;
      vat:=case when p_data ? 'vat' then public.office_business_integer(p_data->'vat',0,1000000000000) else public.office_business_vat(ln.quantity::numeric*ln.unit_price,tax) end;
      if (tax<>'taxable' and vat<>0) or vat>public.office_business_vat(ln.quantity::numeric*ln.unit_price,'taxable')+10 then raise exception 'business_input'; end if;
      update public.office_business_lines set tax_type=tax,vat=business_write.vat where id=ln.id;
      result_id:=ln.id;
    elsif p_action='order.source' then
      -- 들어온 경로: 비우면(null) 모름. 소개가 아니면 소개한 거래처·사람은 지운다
      k:=p_data->>'source';
      if (k is not null and k not in ('referral','returning','inbound','search_sns','other','campaign')) or length(coalesce(p_data->>'referrer_name',''))>100 then raise exception 'business_input'; end if;
      if k='referral' and p_data->>'referrer_customer_id' is not null and not exists(select 1 from public.office_business_customers where id=(p_data->>'referrer_customer_id')::uuid and scope=sc) then raise exception 'business_not_found'; end if;
      update public.office_business_orders set source=k,
        referrer_customer_id=case when k='referral' then (p_data->>'referrer_customer_id')::uuid end,
        referrer_name=case when k='referral' then trim(coalesce(p_data->>'referrer_name','')) else '' end where id=ord.id;
      if k is distinct from 'campaign' then
        -- 캠페인이 아닌 경로로 바꾸면 캠페인 연결도 같은 쓰기에서 푼다(분리 검수 M1 — 두 번에 나눠 쓰다 중간에 실패하면 화면마다 경로가 달랐다)
        select a.campaign_id,a.version into mk_campaign,n from public.office_marketing_attributions a where a.order_id=ord.id and a.scope=sc and a.campaign_id is not null for update;
        if found then
          update public.office_marketing_attributions set campaign_id=null,version=n+1 where order_id=ord.id and scope=sc;
          insert into public.office_marketing_history(scope,order_id,previous_campaign_id,campaign_id,actor,version) values(sc,ord.id,mk_campaign,null,who,n+1);
        end if;
      end if;
    elsif p_action='link.add' then
      k:=p_data->>'kind';
      if k is null or k not in ('page','mail','file','note') or length(coalesce(p_data->>'ref',''))>500 or length(coalesce(p_data->>'title',''))>200
        or length(coalesce(p_data->>'body',''))>10000 or (k='note' and length(trim(coalesce(p_data->>'body','')))=0) or (k<>'note' and length(coalesce(p_data->>'ref',''))=0) then raise exception 'business_input'; end if;
      if (select count(*) from public.office_business_links where order_id=ord.id)>=200 then raise exception 'business_total_limit'; end if;
      insert into public.office_business_links(scope,order_id,kind,ref,title,body,created_by) values(sc,ord.id,k,coalesce(p_data->>'ref',''),coalesce(p_data->>'title',''),coalesce(p_data->>'body',''),who) returning id into result_id;
    elsif p_action='order.cancel' then
      select coalesce(sum(case when e.kind='invoice' then e.amount when e.kind='credit' then -e.amount else 0 end),0),
             coalesce(sum(case when e.kind='payment' then e.amount when e.kind='refund' then -e.amount else 0 end),0),
             coalesce(sum(case when e.kind='invoice' then e.vat when e.kind='credit' then -e.vat else 0 end),0)
        into billed,paid,gross_vat from public.office_business_entries e where e.order_id=ord.id;
      if ord.status='cancelled' or paid>0 or exists(select 1 from public.office_business_lines where order_id=ord.id and fulfilled>0) then raise exception 'business_order_state'; end if;
      at_ts:=public.office_business_at(p_data->'at');
      if at_ts<coalesce(ord.confirmed_at,ord.created_at) or exists(select 1 from public.office_business_entries where order_id=ord.id and at>at_ts) then raise exception 'business_dates'; end if;
      if billed>0 then
        insert into public.office_business_entries(scope,order_id,kind,amount,at,note,supply,vat) values(sc,ord.id,'credit',billed::bigint,at_ts,'',(billed-gross_vat)::bigint,gross_vat::bigint);
        insert into public.office_business_activity(scope,order_id,kind,at,actor,amount) values(sc,ord.id,'credit',at_ts,who,billed::bigint);
      end if;
      if ord.status='confirmed' then
        for ln in select * from public.office_business_lines where order_id=ord.id and kind='product' order by item_id,id loop
          update public.office_business_items set reserved=reserved-ln.quantity,version=version+1 where id=ln.item_id;
          insert into public.office_business_movements(scope,item_id,order_id,line_id,kind,quantity) values(sc,ln.item_id,ord.id,ln.id,'release',ln.quantity);
        end loop;
      end if;
      update public.office_business_orders set status='cancelled',cancelled_at=at_ts where id=ord.id;
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'cancel',at_ts,who,coalesce(p_data->>'note',''));
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
        select coalesce(sum((l.quantity-l.returned)::numeric*l.unit_price),0), coalesce(sum(floor(l.vat::numeric*(l.quantity-l.returned)/l.quantity)),0)
          into total,gross_vat from public.office_business_lines l where l.order_id=ord.id;
        gross:=total+gross_vat;
        select coalesce(sum(case when e.kind='invoice' then e.amount when e.kind='credit' then -e.amount else 0 end),0),
               coalesce(sum(case when e.kind='payment' then e.amount when e.kind='refund' then -e.amount else 0 end),0)
          into billed,paid from public.office_business_entries e where e.order_id=ord.id;
        if (k='invoice' and amount>gross-billed) or (k='credit' and amount>billed) or (k='payment' and amount>billed-paid) or (k='refund' and amount>paid) then raise exception 'business_amount_exceeds_balance'; end if;
        at_ts:=public.office_business_at(p_data->'at');
        if ord.confirmed_at is not null and at_ts<ord.confirmed_at then raise exception 'business_dates'; end if;
        supply:=null; vat:=null;
        if k in ('invoice','credit') then
          if p_data ? 'vat' then
            vat:=public.office_business_integer(p_data->'vat',0,amount); supply:=amount-vat;
          else
            vat:=case when gross>0 then round(amount*gross_vat/gross) else 0 end; supply:=amount-vat;
          end if;
        end if;
        insert into public.office_business_entries(scope,order_id,kind,amount,at,note,supply,vat) values(sc,ord.id,k,amount,at_ts,coalesce(p_data->>'note',''),supply,vat) returning id into result_id;
        insert into public.office_business_activity(scope,order_id,kind,at,actor,amount) values(sc,ord.id,k,at_ts,who,amount);
      end if;
    end if;
  elsif p_action in ('redact.set','redact.bulk') then
    -- 부분 가림(유건 9/29): 항목 단위 표시. 값은 그대로 두고 화면에서만 먼지로 덮는다(인트라넷 시머와 같은 성격)
    -- redact.bulk: 표에서 끌어 고른 여러 칸을 한 번의 쓰기로(최대 500칸). 한 칸이라도 틀리면 예외로 전체가 되돌아간다
    if p_action='redact.bulk' and (jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 500) then raise exception 'business_input'; end if;
    for el in select * from jsonb_array_elements(case when p_action='redact.bulk' then p_data->'items' else jsonb_build_array(p_data) end) loop
      f:=el->>'field'; on_off:=(el->'on')::text='true';
      if jsonb_typeof(el->'on') is distinct from 'boolean' then raise exception 'business_input'; end if;
      result_id:=(el->>'id')::uuid;
      if el->>'entity'='customer' then
        if f is null or f not in ('email','ceo','biz_no','manager','phone','address','account','notes') then raise exception 'business_input'; end if;
        update public.office_business_customers set redacted=case when on_off then array(select distinct x from unnest(redacted||array[f]) x) else array_remove(redacted,f) end where id=result_id and scope=sc;
      elsif el->>'entity'='order' then
        if f is null or f not in ('title','amount') then raise exception 'business_input'; end if;
        update public.office_business_orders set redacted=case when on_off then array(select distinct x from unnest(redacted||array[f]) x) else array_remove(redacted,f) end where id=result_id and scope=sc;
      else raise exception 'business_input'; end if;
      if not found then raise exception 'business_not_found'; end if;
    end loop;
  elsif p_action='link.remove' then
    delete from public.office_business_links where id=(p_data->>'id')::uuid and scope=sc returning * into lk;
    if not found then raise exception 'business_not_found'; end if;
    result_id:=lk.id;
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
    'links',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.created_at,r.id),'[]') from public.office_business_links r where scope=sc),
    'activity',(select coalesce(jsonb_agg(to_jsonb(r)-'scope' order by r.at,r.id),'[]') from public.office_business_activity r where scope=sc),
    'settings',coalesce(settings,'{"enabled":["customers","catalog","orders","inventory","payments","analytics"],"dashboards":[],"performance":{},"version":1}'),
    'can_write',writable,'can_manage',writable);
end $$;

create or replace function public.office_business_report(p_org uuid,p_from date,p_to date,p_customer uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); result jsonb;
begin
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 then raise exception 'business_dates'; end if;
  if p_customer is not null and not exists(select 1 from public.office_business_customers where id=p_customer and scope=sc) then raise exception 'business_not_found'; end if;
  with orders as (
    select * from public.office_business_orders where scope=sc and (p_customer is null or customer_id=p_customer)
  ), events as (
    select o.id order_id,(o.confirmed_at at time zone 'Asia/Seoul')::date as day,l.kind,l.quantity::numeric*l.unit_price sales,0::numeric invoiced,0::numeric paid,0::numeric vat
      from orders o join public.office_business_lines l on l.order_id=o.id where o.confirmed_at is not null
    union all
    select o.id,(o.cancelled_at at time zone 'Asia/Seoul')::date,l.kind,-l.quantity::numeric*l.unit_price,0,0,0
      from orders o join public.office_business_lines l on l.order_id=o.id where o.cancelled_at is not null and o.confirmed_at is not null
    union all
    select o.id,(m.at at time zone 'Asia/Seoul')::date,'product',-m.book_amount,0,0,0
      from orders o join public.office_business_movements m on m.order_id=o.id where m.kind='return'
    union all
    select o.id,(e.at at time zone 'Asia/Seoul')::date,null,0,
      case when e.kind='invoice' then e.amount when e.kind='credit' then -e.amount else 0 end,
      case when e.kind='payment' then e.amount when e.kind='refund' then -e.amount else 0 end,
      case when e.kind='invoice' then coalesce(e.vat,0) when e.kind='credit' then -coalesce(e.vat,0) else 0 end
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
      'receivable',coalesce((select sum(invoiced-paid) from events where day<=p_to),0),'vat',coalesce((select sum(vat) from period),0)),
    'daily',coalesce((select jsonb_agg(to_jsonb(d) order by date) from (select day date,sum(sales) sales,sum(invoiced) invoiced,sum(paid) paid,sum(vat) vat from period group by day) d),'[]'),
    'sources',coalesce((select jsonb_agg(to_jsonb(x) order by x.sales desc,x.source) from (select coalesce(o.source,'unknown') source,sum(p.sales) sales from period p join orders o on o.id=p.order_id group by 1) x),'[]'),
    'mix',coalesce((select jsonb_agg(to_jsonb(m) order by kind) from (select kind,sum(sales) amount from period where kind is not null group by kind) m),'[]'),
    'orders',coalesce((select jsonb_agg(to_jsonb(g) order by g.title,g.id) from grouped g),'[]')
  ) into result;
  if exists(select 1 from jsonb_path_query(result,'$.** ? (@.type() == "number")') v where abs((v#>>'{}')::numeric)>9007199254740991) then raise exception 'business_aggregate_limit'; end if;
  return result;
end $$;

create or replace function public.office_marketing_period(p_org uuid,p_from date,p_to date,p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); ledger jsonb; result jsonb;
begin
 ledger:=public.office_business_report(p_org,p_from,p_to,null);
 with campaign_groups as (
  select c.id,c.name,c.channel from public.office_marketing_campaigns c where c.scope=sc and (p_campaign is null or c.id=p_campaign)
  union all select null::uuid,null::text,null::text where p_campaign is null
 ), order_rows as (
  select r.*,a.campaign_id,
   (case when (o.confirmed_at at time zone 'Asia/Seoul')::date between p_from and p_to then 1 else 0 end
    - case when o.confirmed_at is not null and (o.cancelled_at at time zone 'Asia/Seoul')::date between p_from and p_to then 1 else 0 end)::numeric order_count
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

create or replace function public.office_marketing_write(p_org uuid,p_key uuid,p_action text,p_data jsonb) returns jsonb
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
  -- 캠페인 연결과 거래의 들어온 경로를 한 번에(분리 검수 M1): 연결하면 경로=캠페인, 풀면 캠페인이던 경로만 모름으로
  update public.office_business_orders o set source=case when marketing_write.campaign_id is not null then 'campaign' when o.source='campaign' then null else o.source end,
    referrer_customer_id=case when marketing_write.campaign_id is not null then null else o.referrer_customer_id end,
    referrer_name=case when marketing_write.campaign_id is not null then '' else o.referrer_name end
   where o.id=result_id and o.scope=sc;
 else raise exception 'marketing_input'; end if;
 insert into public.office_business_requests(actor,key,payload,result) values(who,p_key,payload,jsonb_build_object('id',result_id));
 return jsonb_build_object('id',result_id);
end $$;

create or replace function public.office_marketing_report(p_org uuid,p_from date,p_to date,p_campaign uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare sc text:=public.office_business_scope(p_org,false); result jsonb; previous jsonb; goals jsonb:='[]'; goal record; goal_metrics jsonb; actual numeric;
begin
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>3660 or p_from<'1900-01-01'::date or p_to>'9990-12-31'::date then raise exception 'marketing_dates'; end if;
 if p_campaign is not null and not exists(select 1 from public.office_marketing_campaigns where scope=sc and id=p_campaign) then raise exception 'marketing_not_found'; end if;
 result:=public.office_marketing_period(p_org,p_from,p_to,p_campaign);
 previous:=public.office_marketing_period(p_org,p_from-(p_to-p_from+1),p_from-1,p_campaign)->'metrics';
 for goal in select * from public.office_marketing_goals where scope=sc and (p_campaign is null or campaign_id=p_campaign) order by starts_on,id loop
  goal_metrics:=public.office_marketing_period(p_org,goal.starts_on,goal.ends_on,goal.campaign_id);
  -- '전체 캠페인' 목표는 캠페인에 연결된 거래만 센다(분리 검수 M4 — 광고와 무관한 매출이 광고 목표를 채우지 않게)
  actual:=case when goal.campaign_id is null then (select coalesce(sum((c->>goal.metric)::numeric),0) from jsonb_array_elements(goal_metrics->'campaigns') c where c->>'id' is not null)
   else (goal_metrics->'metrics'->>goal.metric)::numeric end;
  goals:=goals||jsonb_build_array((to_jsonb(goal)-'scope')||jsonb_build_object('actual',actual,'ratio',actual/goal.target));
 end loop;
 result:=result||jsonb_build_object('previous',previous,'goals',goals);
 if exists(select 1 from jsonb_path_query(result,'$.** ? (@.type() == "number")') v where abs((v#>>'{}')::numeric)>9007199254740991) then raise exception 'marketing_aggregate_limit'; end if;
 return result;
end $$;

revoke all on function public.office_business_at(jsonb),public.office_business_vat(numeric,text) from public,anon,authenticated;
revoke all on function public.office_business_write(uuid,uuid,text,jsonb),public.office_business_read(uuid),public.office_business_report(uuid,date,date,uuid) from public,anon;
grant execute on function public.office_business_write(uuid,uuid,text,jsonb),public.office_business_read(uuid),public.office_business_report(uuid,date,date,uuid) to authenticated;
