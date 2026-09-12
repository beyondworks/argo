-- companies 버킷 RLS를 인덱스가 타는 범위 비교로 — 실측 2026-09-12: 같은 storage.search(오너 접두사, 객체 39개)가
-- 슈퍼유저 67ms vs 인증 사용자 15,112ms(225배). 원인 = 정책의 (storage.foldername(name))[1] = uid 가 행마다 함수 호출이라
-- (bucket_id, name COLLATE "C") 인덱스를 못 탄다. 트랜잭션 안에서 아래 정책으로 바꿔 재측정 → 57.9ms(롤백 후 적용).
-- 의미는 동일: 이름이 '<uid>/'로 시작한다 ('0'은 ASCII에서 '/' 다음 문자, name 첫 세그먼트는 전부 uuid — 동치성 쿼리로 확인).
-- 배경: 30분에 목록 조회 82건 × 13.5초 = DB 시간 1,100초. 이것이 노드 하트비트·동기화 색인·PostgREST 타임아웃(30분당 100건)의 배경이었다.
alter policy companies_owner_select on storage.objects
  using (bucket_id = 'companies'
         and (name collate "C") >= ((select auth.uid())::text || '/')
         and (name collate "C") <  ((select auth.uid())::text || '0'));
alter policy companies_owner_update on storage.objects
  using (bucket_id = 'companies'
         and (name collate "C") >= ((select auth.uid())::text || '/')
         and (name collate "C") <  ((select auth.uid())::text || '0'));
alter policy companies_owner_delete on storage.objects
  using (bucket_id = 'companies'
         and (name collate "C") >= ((select auth.uid())::text || '/')
         and (name collate "C") <  ((select auth.uid())::text || '0'));
-- insert·update의 with check(행 1개 판정)는 스캔이 아니라 그대로 둔다(is_pro()·리스·클레임 예외 포함).
