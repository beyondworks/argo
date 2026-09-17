-- 한 회사 폴더(ws_id)의 크루를 다른 계정 소유로 올리지 못하게(실사고 2026-09-17 윈도우 PC).
--   예전 계정(beyondworks)이 쓰던 회사 폴더가 남은 PC에 다른 계정(lean8kim)으로 로그인하자, 앱이 그 회사 크루 12명을 새 계정 소유로
--   lean-win·Lean-AX에 24행 미러했다(소유자 게이트 이전 빌드, 게이트도 "소유자가 있을 때만 비교"라 미기록·읽기 실패가 통과).
--   앱 게이트는 새 빌드에만 닿는다 — 옛 빌드가 남은 기기까지 막으려고 서버가 마지막으로 거른다.
-- 판정(분리 검수 MEDIUM-A 반영 — ws_id만 같으면 거부하던 첫 판은 정당한 주인을 영구히 잠글 수 있었다):
--   로컬 크루를 넣을 때, 같은 ws_id에 다른 소유자의 로컬 크루가 있고 **그 소유자는 클라우드에 이 회사 폴더가 있는데
--   넣는 계정은 없으면** 거부한다. 회사 폴더의 주인은 동기화 저장소(companies/<uid>/<ws>/)가 말해 준다.
--   · 폴더 이름 우연 충돌(co-XXXX): 두 계정 모두 자기 저장소가 있거나 둘 다 없으면 통과
--   · 계정 이전(새 계정으로 동기화): 새 계정 저장소가 있으면 통과
--   · 옛 빌드가 원래 주인보다 먼저 올린 경우: 원래 주인은 저장소가 있어 통과
--   · 상주 크루(조직 노드, 서비스 계정 교체)는 대상 밖
-- 한계: 동기화를 한 번도 안 한 회사는 서버가 주인을 모른다 — 앱 게이트(소유자 = 로그인 계정일 때만)가 막는다.
create or replace function public.msgr_crews_ws_owner_gate() returns trigger
  language plpgsql security definer set search_path = public, storage, pg_temp as $$
begin
  if new.hosting = 'local' and new.ws_id is not null and new.ws_id <> 'bot'
     and not exists (select 1 from storage.objects o where o.bucket_id = 'companies' and o.name like new.owner_user_id::text || '/' || new.ws_id || '/%')
     and exists (select 1 from public.msgr_crews x
                  where x.ws_id = new.ws_id and x.owner_user_id <> new.owner_user_id and x.hosting = 'local'
                    and exists (select 1 from storage.objects o where o.bucket_id = 'companies' and o.name like x.owner_user_id::text || '/' || new.ws_id || '/%')) then
    raise exception 'msgr_ws_owned_by_other' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.msgr_crews_ws_owner_gate() from public, anon, authenticated;
drop trigger if exists msgr_crews_ws_owner_gate on public.msgr_crews;
create trigger msgr_crews_ws_owner_gate before insert on public.msgr_crews for each row execute function public.msgr_crews_ws_owner_gate();
