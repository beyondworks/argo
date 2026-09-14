-- '/' 커맨더(유건 지시 2026-09-14): 크루가 사는 회사의 별칭(company.json.aliases)·설치 스킬(skills/) 목록을 크루 행에 미러한다.
-- 게이트웨이가 폴마다 계산해 바뀐 경우에만 갱신(소유자 RLS msgr_crews_update_owner) → 본체에서 스킬·별칭이 바뀌면 다음 폴에 반영.
-- 이름·제목·별칭 본문만 싣는다. 스킬 본문·키·기억은 싣지 않는다.
alter table public.msgr_crews add column if not exists commands jsonb not null default '[]'::jsonb;
alter table public.msgr_crews drop constraint if exists msgr_crews_commands_check;
alter table public.msgr_crews add constraint msgr_crews_commands_check
  check (jsonb_typeof(commands) = 'array' and pg_column_size(commands) <= 65536);
