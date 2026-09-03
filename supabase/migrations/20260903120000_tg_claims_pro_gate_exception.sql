-- 텔레그램 토큰 클레임(.tg-claims/<지문>.json)을 Pro 게이트 예외에 추가 — 2026-09-03 (PR #424 분리 검수 H-1)
--
-- 왜: 텔레그램 폴러 주체가 "기기 리더 하나"에서 "토큰마다 클레임한 기기"로 바뀌었다(봇 토큰은 기기별 저장이라
--     리더에 토큰이 없으면 아무도 안 받던 결함). 클레임 파일은 리스 파일(_device-lease.json)과 같은 성격의
--     이중 실행 방지 조정이지 과금 대상 자료가 아니다. 예외가 없으면 비-Pro(체험 15일째부터) 계정은 업로드 403
--     → 클레임 실패 → 텔레그램 전면 미수신이 된다(무료 = 로컬 전부 무제한·단일 기기 보장 위반).
-- 오너 경계(foldername[1] = auth.uid())는 그대로라 남의 클레임은 건드릴 수 없다. 예외는 프리픽스가 아니라 **실제 키 형태**
-- (sha256 지문 24 hex + .json)로만 연다 — 비-Pro 계정이 .tg-claims/ 아래를 무제한 저장 채널로 쓰는 표면 차단(검수 L-A).
-- select/delete 정책은 Pro 게이트가 없어(20260723001629) 클레임 download·remove는 추가 예외 없이 된다. 폴더는 점 접두(.tg-claims)라
-- 동기화 발견·내보내기가 회사로 오인하지 않는다.

drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and (
      public.is_pro()
      or name = (select auth.uid()::text) || '/_device-lease.json'
      or name ~ ('^' || (select auth.uid()::text) || '/\.tg-claims/[0-9a-f]{24}\.json$')
    )
  );

drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and (
      public.is_pro()
      or name = (select auth.uid()::text) || '/_device-lease.json'
      or name ~ ('^' || (select auth.uid()::text) || '/\.tg-claims/[0-9a-f]{24}\.json$')
    )
  );
