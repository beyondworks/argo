-- 긴급(2026-09-16): 크루 하트비트마다 큰 열(commands, 크루당 최대 6.5KB)이 TOAST에 다시 쓰였다.
--   · 앱은 크루의 last_seen_at만 자주 갱신한다(누적 약 14만 회). 그런데 잠금 열 보호 트리거 msgr_lock_crews가 매 갱신마다
--     돌았고, msgr_lock_cols는 선언부에서 to_jsonb(new)/to_jsonb(old)로 행 전체를 풀어 읽었다 → 큰 열까지 새로 저장.
--   · 라이브 관찰(읽기 전용): msgr_crews 166행이 817MB, 죽은 행 약 30만. TOAST 삽입 104만 회 중 commands를 실제로 바꾼 갱신은 35회.
--     11:05 'Disk IO 예산 소진' 경고의 원인.
-- 처방 두 겹:
--   1) 크루 잠금 트리거는 잠금 열이 실제로 바뀔 때만 돈다(WHEN). 잠금 열 변경은 여전히 막힌다.
--   2) msgr_lock_cols는 조기 통과(서비스 역할·중첩 트리거) 뒤에만 행을 JSON으로 읽는다 — 다른 표의 같은 트리거에도 이롭다.

create or replace function public.msgr_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb; o jsonb;
begin
  if auth.uid() is null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if; -- FK 캐스케이드(on delete set null)·다른 트리거의 내부 UPDATE는 통과(실측: 크루 삭제가 막혔다)
  n := to_jsonb(new); o := to_jsonb(old); -- 통과할 갱신에서는 행을 풀어 읽지 않는다(2026-09-16 — 큰 열이 TOAST에 다시 쓰였다)
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then
      if col = 'created_by' and current_setting('argo.msgr_account_delete', true) = '1' then continue; end if; -- msgr_delete_me 전용: 작성자 이관만
      raise exception 'msgr_immutable_%', col;
    end if;
  end loop;
  return new;
end $$;

drop trigger if exists msgr_lock_crews on public.msgr_crews;
create trigger msgr_lock_crews before update on public.msgr_crews for each row
  when (old.org_id is distinct from new.org_id or old.owner_user_id is distinct from new.owner_user_id
        or old.ws_id is distinct from new.ws_id or old.slug is distinct from new.slug
        or old.registered_at is distinct from new.registered_at or old.hosting is distinct from new.hosting)
  execute function public.msgr_lock_cols('org_id', 'owner_user_id', 'ws_id', 'slug', 'registered_at', 'hosting');
