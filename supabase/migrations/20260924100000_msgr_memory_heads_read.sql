-- 채널·조직 기억 경계(docs/msgr-memory-boundary.md P1, 유건 결정 2026-09-24).
-- 채널 기억(msgr_org_docs의 채널 범위 문서 — 서버 일지 journal/ 포함)은 채널을 읽을 수 있는 사람 외에 방장도 읽는다.
-- 방장 = msgr_is_channel_host: 1:1 대화 제외, 조직 활성 멤버, 채널을 만든 사람·채널장(admin_user_ids)·조직장(owner·admin).
-- 그래서 조직장은 멤버가 아닌 비공개 채널 기억을 읽고, 채널장은 채널을 나가도 자기 채널 기억을 읽는다.
-- 나간 멤버·게스트는 종전대로 못 읽고, 조직에서 나가면(msgr_is_member 거짓) 장의 권한도 끝난다. 전사 문서 규칙은 그대로.
drop policy if exists msgr_docs_select on public.msgr_org_docs;
create policy msgr_docs_select on public.msgr_org_docs for select to authenticated
  using ((channel_id is null and public.msgr_role(org_id) in ('owner', 'admin', 'member'))
      or (channel_id is not null and (public.msgr_can_read_channel(channel_id) or public.msgr_is_channel_host(channel_id))));
