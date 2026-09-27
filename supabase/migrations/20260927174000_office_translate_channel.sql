-- 아르고 오피스 메일 번역 통로(유건 2026-09-27: 메일 주인 본인의 구독으로, 버튼 누를 때만).
-- 오피스 화면과 주인 기기의 Argo 앱이 비공개 실시간 토픽 ot:<본인 uid>로 요청·결과를 주고받는다.
-- 웹소켓 방송이라 메일 내용은 DB에 쓰이지 않는다(realtime.send를 쓰지 않는다 — 그것은 realtime.messages에 행을 남긴다).
-- u:<uid>(중단 방송의 정본, 클라이언트 발신 금지)와 org:%는 그대로 둔다 — 번역 전용 토픽을 따로 둬서 위조 방송 경로를 넓히지 않는다.
-- 정책은 비공개 채널에서만 적용된다 — 양쪽 모두 { config: { private: true } }로 구독한다(apps/office/src/core/translate.js, src/gateway/msgr.mjs).

drop policy if exists office_translate_recv on realtime.messages;
create policy office_translate_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'ot:' || (select auth.uid())::text);

drop policy if exists office_translate_send on realtime.messages;
create policy office_translate_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'ot:' || (select auth.uid())::text);
