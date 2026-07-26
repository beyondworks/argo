# 부하 정기 점검 — DB 상위 소비 쿼리

> 2026-07-26 Supabase CPU 80% 경보 후 신설. **문제를 외부(벤더 메일·사용자 신고)가 알려주는 구조**를
> 끊는 게 목적이다. 주 1회 5분이면 된다.

## 왜 필요한가

경보가 왔을 때 실측하니 `storage.search()` 하나가 **DB CPU의 98.3%**(93.7만 회·평균 177ms)였다.
2위와 140배 차이라 **한 번만 봤으면 즉시 보였을 것**이다. 그런데 아무도 안 보고 있었다.

## 점검 (주 1회 · Supabase MCP 또는 SQL 편집기)

```sql
SELECT round((total_exec_time/1000)::numeric,1) AS total_s,
       calls,
       round(mean_exec_time::numeric,2) AS mean_ms,
       round((100*total_exec_time/sum(total_exec_time) OVER ())::numeric,1) AS pct,
       left(regexp_replace(query, E'[\\n\\r ]+', ' ', 'g'), 120) AS q
FROM pg_stat_statements
ORDER BY total_exec_time DESC LIMIT 12;
```

## 판정 기준

| 신호 | 의미 | 조치 |
|---|---|---|
| 1위가 **50% 초과** | 한 경로가 DB를 독점 — 거의 항상 주기 실행의 곱셈 | 호출처를 찾아 주기·범위를 줄인다 |
| `mean_ms` **> 50** 인데 호출이 많음 | 비싼 연산을 자주 부른다 | 캐시하거나 주기를 나눈다 |
| `calls`가 **사용자 수보다 훨씬 빠르게** 증가 | 기기·회사 수에 선형인 루프 | 관문 0.5(규모 질문)로 되돌아간다 |

## 함께 보는 것

```sql
-- 스토리지 규모(객체 수가 늘면 list()가 같이 느려진다)
SELECT count(*) objects, count(DISTINCT split_part(name,'/',1)) owners,
       round(sum((metadata->>'size')::bigint)/1024.0/1024.0) mb
FROM storage.objects WHERE bucket_id='companies';
```

## 기록

점검 후 이상이 없어도 **날짜와 1위 쿼리·비율**을 핸드오버에 한 줄 남긴다 — 추세가 보여야
"갑자기 늘었다"를 알 수 있다.

| 날짜 | 1위 쿼리 | 비율 | 조치 |
|---|---|---|---|
| 2026-07-26 | `storage.search()` | 98.3% | 목록 조회 주기 분리(8s → 60s), 87% 감소 예상 |
