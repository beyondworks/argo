-- 거래·거래처 보강(오피스 14차 트랙 B, 2026-10-04). 명세: _worktrees/office-r5-spec/spec14.md "트랙 B", 근거 PARITY-customers.md D1·D2·D3·F2·F9·K5.
--  1. 입금 예정일: 거래(주문)에 due_on. 만들 때·고칠 때 넣고, 입금이 다 되지 않았는데 날짜가 지나면 화면이 '입금 지연 N일'을 보여 준다(계산은 화면, 저장은 날짜만).
--  2. 거래처 분류에 공급사(supplier)·기타(other).
--  3. 거래 고치기(order.update): 건명·거래처·입금 예정일은 언제든, 금액(줄)은 견적 단계까지. 장부(청구·입금 기록)는 지우지 않는다.
--     계약한 거래부터 금액을 잠그는 이유(분리 검수 MEDIUM-1, 총괄 결정 10/4): 성과 기록(office_perf_compute)은 계약 금액을 지금 품목 줄 합계로 센다.
--     계약 뒤 줄을 고치면 잠근 지난달 평가가 바뀐다(유건 원칙 "성과 기록은 고쳐지지 않는다"). 바뀐 금액은 청구·청구 취소로 기록한다.
--     고친 내용은 거래 기록(activity)에 이전 값과 함께 남는다 — 건명 바꿈(retitle)·거래처 옮김(move)·금액 고침(reprice)·입금 예정일 바꿈(due), 거래마다 200번까지.
--  4. 거래처 보관·되살리기(customer.archive): 지우지 않고 보관 시각(archived_at)만. 보관한 거래처로는 새 거래를 만들지 않는다.
-- 읽기(office_business_read)는 표의 모든 칸을 그대로 돌려주므로(to_jsonb) 다시 만들지 않는다 — due_on·archived_at이 자연히 실린다.
-- 쓰기 함수는 가장 최근 정의(20260929140000_office_deal_flow.sql)를 바탕으로 위 동작만 더했다. 권한(관리자만 쓰기)·오류 코드·요청 번호는 그대로다.
-- 부하: 쓰기는 사람이 누를 때만. 주기 호출·폴링 없음. 같은 값은 다시 쓰지 않는다(바뀐 칸·바뀐 줄·이미 보관한 거래처는 건너뜀).

alter table public.office_business_orders add column if not exists due_on date check (due_on between date '2000-01-01' and date '2100-12-31');
alter table public.office_business_customers add column if not exists archived_at timestamptz;

-- 분류 제약을 넓힌다(이름이 바뀌었을 수 있어 정의로 찾는다)
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.office_business_customers'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mcategory\M' loop
    execute format('alter table public.office_business_customers drop constraint %I', c);
  end loop;
end $$;
alter table public.office_business_customers add constraint office_business_customers_category_check check (category in ('customer','partner','supplier','other'));

-- 거래 기록 종류에 고친 기록 넷을 더한다
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'public.office_business_activity'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mkind\M' loop
    execute format('alter table public.office_business_activity drop constraint %I', c);
  end loop;
end $$;
alter table public.office_business_activity add constraint office_business_activity_kind_check
  check (kind in ('quote','contract','reopen','invoice','credit','payment','refund','cancel','retitle','move','reprice','due'));

-- 입금 예정일 값: 'YYYY-MM-DD'(2000~2100년) 또는 비움(null). 그 밖은 business_due
create or replace function public.office_business_due(value jsonb) returns date
language plpgsql immutable set search_path = public, pg_temp as $$
declare result date;
begin
  if value is null or jsonb_typeof(value) = 'null' then return null; end if;
  if jsonb_typeof(value) <> 'string' or (value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'business_due'; end if;
  begin result := (value#>>'{}')::date; exception when others then raise exception 'business_due'; end;
  if result not between date '2000-01-01' and date '2100-12-31' then raise exception 'business_due'; end if;
  return result;
end $$;

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
  new_title text; new_customer uuid; due date; old_name text; norm jsonb; changed_lines boolean; logs int; uids uuid[];
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
       or coalesce(p_data->>'category','customer') not in ('customer','partner','supplier','other') or coalesce(p_data->>'status','active') not in ('active','hold','closed')) then raise exception 'business_input'; end if;
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
    if customer.archived_at is not null then raise exception 'business_customer_archived'; end if; -- 보관한 거래처로는 새 거래를 만들지 않는다(14차)
    at_ts:=public.office_business_at(p_data->'at');
    due:=public.office_business_due(p_data->'due_on'); -- 입금 예정일(14차) — 없으면 비워 둔다
    insert into public.office_business_orders(scope,customer_id,title,created_at,due_on) values(sc,customer.id,trim(p_data->>'title'),at_ts,due) returning id into result_id;
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
  elsif p_action='order.update' then
    -- 거래 고치기(14차): 건명·거래처·입금 예정일은 언제든, 금액(줄)은 견적 단계까지. 준 칸만 보고 바뀐 칸만 쓴다(같은 값은 다시 쓰지 않는다).
    -- 장부(청구·입금 기록)는 건드리지 않는다. 고친 내용은 기록(activity)에 이전 값과 함께 남긴다 — 거래마다 200번까지.
    select * into ord from public.office_business_orders where id=(p_data->>'id')::uuid and scope=sc for update;
    if not found then raise exception 'business_not_found'; end if;
    result_id:=ord.id;
    new_title:=ord.title; new_customer:=ord.customer_id; due:=ord.due_on; changed_lines:=false;
    if p_data ? 'title' then
      if jsonb_typeof(p_data->'title') is distinct from 'string' or length(trim(p_data->>'title')) not between 1 and 200 then raise exception 'business_input'; end if;
      new_title:=trim(p_data->>'title');
    end if;
    if p_data ? 'due_on' then due:=public.office_business_due(p_data->'due_on'); end if;
    if p_data ? 'customer_id' then
      -- 거래처는 비울 수 없다. 이관이 만든 '(거래처 미지정)'도 보통 거래처라 그리로 옮길 수 있다
      if jsonb_typeof(p_data->'customer_id') is distinct from 'string' then raise exception 'business_input'; end if;
      select * into customer from public.office_business_customers where id=(p_data->>'customer_id')::uuid and scope=sc;
      if not found then raise exception 'business_not_found'; end if;
      if customer.id<>ord.customer_id and customer.archived_at is not null then raise exception 'business_customer_archived'; end if;
      new_customer:=customer.id;
    end if;
    if p_data ? 'lines' then
      if jsonb_typeof(p_data->'lines') is distinct from 'array' or jsonb_array_length(p_data->'lines') not between 1 and 100 then raise exception 'business_input'; end if;
      norm:='[]'::jsonb; total:=0;
      for el in select value from jsonb_array_elements(p_data->'lines') loop
        if jsonb_typeof(el) is distinct from 'object' then raise exception 'business_input'; end if;
        select * into item from public.office_business_items where id=(el->>'item_id')::uuid and scope=sc;
        if not found then raise exception 'business_not_found'; end if;
        quantity:=public.office_business_integer(el->'quantity',1,1000000);
        amount:=public.office_business_integer(el->'unit_price',0,1000000000000);
        tax:=coalesce(el->>'tax_type','taxable');
        if tax not in ('taxable','zero','exempt') then raise exception 'business_input'; end if;
        vat:=case when el ? 'vat' then public.office_business_integer(el->'vat',0,1000000000000) else public.office_business_vat(quantity::numeric*amount,tax) end;
        if (tax<>'taxable' and vat<>0) or vat>public.office_business_vat(quantity::numeric*amount,'taxable')+10 then raise exception 'business_input'; end if;
        total:=total+quantity::numeric*amount+vat;
        if total>1000000000000 then raise exception 'business_total_limit'; end if;
        if el->>'id' is not null then
          if not exists(select 1 from public.office_business_lines l where l.id=(el->>'id')::uuid and l.order_id=ord.id) then raise exception 'business_not_found'; end if;
          if exists(select 1 from jsonb_array_elements(norm) x where x->>'id'=el->>'id') then raise exception 'business_input'; end if;
        end if;
        norm:=norm||jsonb_build_array(jsonb_build_object('id',el->>'id','item_id',item.id,'name',item.name,'kind',item.kind,'quantity',quantity,'unit_price',amount,'tax_type',tax,'vat',vat));
      end loop;
      changed_lines:=(select count(*) from public.office_business_lines l where l.order_id=ord.id)<>jsonb_array_length(norm)
        or exists(select 1 from jsonb_array_elements(norm) x where x->>'id' is null)
        or exists(select 1 from jsonb_array_elements(norm) x join public.office_business_lines l on l.id=(x->>'id')::uuid
          where (l.item_id,l.quantity,l.unit_price,l.tax_type,l.vat) is distinct from ((x->>'item_id')::uuid,(x->>'quantity')::bigint,(x->>'unit_price')::bigint,x->>'tax_type',(x->>'vat')::bigint));
      -- 금액은 한 번도 계약하지 않은 견적까지: 계약한 거래(청구·입금·납품은 모두 계약 뒤에만 생긴다)·취소한 거래·견적으로 되돌린 거래는 거절한다 —
      -- 성과 기록은 계약 금액을 지금 줄 합계로 세므로, 되돌려 고친 뒤 다시 계약해도 잠근 지난달 평가가 바뀐다(10/4 분리 검수)
      if changed_lines and (ord.status<>'draft' or exists(select 1 from public.office_business_activity a where a.order_id=ord.id and a.kind='contract')) then raise exception 'business_amount_locked'; end if;
    end if;
    -- 기록 상한: 고친 기록(건명·거래처·금액·입금 예정일 바꿈)은 거래마다 200번까지. 처음 정하는 입금 예정일은 기록하지 않는다
    logs:=(case when new_title is distinct from ord.title then 1 else 0 end)+(case when new_customer is distinct from ord.customer_id then 1 else 0 end)
      +(case when changed_lines then 1 else 0 end)+(case when due is distinct from ord.due_on and ord.due_on is not null then 1 else 0 end);
    if logs>0 and (select count(*) from public.office_business_activity a where a.order_id=ord.id and a.kind in ('retitle','move','reprice','due'))+logs>200 then raise exception 'business_edit_limit'; end if;
    if changed_lines then
      select coalesce(sum(l.quantity::numeric*l.unit_price+l.vat),0) into gross from public.office_business_lines l where l.order_id=ord.id;
      for ln in select * from public.office_business_lines l where l.order_id=ord.id and not exists(select 1 from jsonb_array_elements(norm) x where x->>'id'=l.id::text) order by l.id loop
        -- 재고 기록이 걸린 줄은 빼지 않는다(재고 장부가 그 줄을 가리킨다)
        if exists(select 1 from public.office_business_movements m where m.line_id=ln.id) then raise exception 'business_line_in_use'; end if;
        delete from public.office_business_lines where id=ln.id;
      end loop;
      -- 견적 거래만 여기 온다 — 재고는 계약할 때 잡으므로(order.confirm) 줄을 고쳐도 재고 잡음은 바뀌지 않는다.
      -- 견적으로 되돌린 거래는 지난 잡음·풀기 기록이 줄을 가리키므로 그 줄은 빼거나 다른 상품으로 바꾸지 않는다(business_line_in_use)
      for el in select value from jsonb_array_elements(norm) loop
        if el->>'id' is not null then
          select * into ln from public.office_business_lines where id=(el->>'id')::uuid;
          if ln.item_id<>(el->>'item_id')::uuid and exists(select 1 from public.office_business_movements m where m.line_id=ln.id) then raise exception 'business_line_in_use'; end if;
          update public.office_business_lines l set item_id=(el->>'item_id')::uuid, name=case when l.item_id=(el->>'item_id')::uuid then l.name else el->>'name' end, kind=el->>'kind',
              quantity=(el->>'quantity')::bigint, unit_price=(el->>'unit_price')::bigint, tax_type=el->>'tax_type', vat=(el->>'vat')::bigint
            where l.id=ln.id and (l.item_id,l.quantity,l.unit_price,l.tax_type,l.vat) is distinct from ((el->>'item_id')::uuid,(el->>'quantity')::bigint,(el->>'unit_price')::bigint,el->>'tax_type',(el->>'vat')::bigint);
        else
          insert into public.office_business_lines(scope,order_id,item_id,name,kind,quantity,unit_price,tax_type,vat)
            values(sc,ord.id,(el->>'item_id')::uuid,el->>'name',el->>'kind',(el->>'quantity')::bigint,(el->>'unit_price')::bigint,el->>'tax_type',(el->>'vat')::bigint);
        end if;
      end loop;
      select coalesce(sum(l.quantity::numeric*l.unit_price+l.vat),0) into total from public.office_business_lines l where l.order_id=ord.id;
      insert into public.office_business_activity(scope,order_id,kind,at,actor,amount,note) values(sc,ord.id,'reprice',clock_timestamp(),who,total::bigint,gross::bigint::text);
    end if;
    if new_title is distinct from ord.title or new_customer is distinct from ord.customer_id or due is distinct from ord.due_on then
      update public.office_business_orders set title=new_title,customer_id=new_customer,due_on=due where id=ord.id;
    end if;
    if new_title is distinct from ord.title then
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'retitle',clock_timestamp(),who,ord.title);
    end if;
    if new_customer is distinct from ord.customer_id then
      select c.name into old_name from public.office_business_customers c where c.id=ord.customer_id;
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'move',clock_timestamp(),who,coalesce(old_name,''));
    end if;
    if due is distinct from ord.due_on and ord.due_on is not null then
      insert into public.office_business_activity(scope,order_id,kind,at,actor,note) values(sc,ord.id,'due',clock_timestamp(),who,ord.due_on::text);
    end if;
  elsif p_action='customer.archive' then
    -- 거래처 보관·되살리기(14차): 지우지 않고 보관 시각만 남긴다. 연결된 거래·문서·일정은 그대로다. 이미 그 상태인 거래처는 다시 쓰지 않는다
    if jsonb_typeof(p_data->'ids') is distinct from 'array' or jsonb_array_length(p_data->'ids') not between 1 and 500 or jsonb_typeof(p_data->'on') is distinct from 'boolean' then raise exception 'business_input'; end if;
    select array_agg(distinct x.v::uuid) into uids from jsonb_array_elements_text(p_data->'ids') x(v);
    if exists(select 1 from unnest(uids) i where not exists(select 1 from public.office_business_customers c where c.id=i and c.scope=sc)) then raise exception 'business_not_found'; end if;
    if (p_data->'on')::text='true' then
      update public.office_business_customers set archived_at=clock_timestamp() where id=any(uids) and scope=sc and archived_at is null;
    else
      update public.office_business_customers set archived_at=null where id=any(uids) and scope=sc and archived_at is not null;
    end if;
    result_id:=uids[1];
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


revoke all on function public.office_business_due(jsonb) from public, anon, authenticated;
revoke all on function public.office_business_write(uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.office_business_write(uuid,uuid,text,jsonb) to authenticated;
