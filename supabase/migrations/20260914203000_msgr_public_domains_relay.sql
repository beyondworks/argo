-- Sign in with Apple 도입(PR #528) 검수 HIGH-1: Apple 비공개 릴레이(privaterelay.appleid.com)·GitHub noreply 도메인이
-- "공개 메일 도메인" 목록에 없어, 그 주소로 로그인한 소유자가 도메인 자동 가입을 켜면 같은 릴레이를 쓰는 모든 사용자에게
-- 조직이 노출되고 초대 없이 들어올 수 있었다. 기존 목록(20260903120000 최신 정의)을 유지한 채 추가하고, 이미 등록된 행은 해제한다.
create or replace function public.msgr_public_email_domain(d text) returns boolean
  language sql immutable as $$
    select lower(d) = any (array['gmail.com','googlemail.com','naver.com','daum.net','hanmail.net','kakao.com','nate.com','outlook.com','outlook.kr','hotmail.com','hotmail.co.kr','live.com','live.co.kr','msn.com',
      'yahoo.com','yahoo.co.kr','yahoo.co.jp','ymail.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','pm.me','tutanota.com','tuta.io','zoho.com','zohomail.com','mail.com','gmx.com','gmx.de','gmx.net',
      'yandex.com','yandex.ru','qq.com','163.com','126.com','sina.com','aol.com','fastmail.com','hey.com','duck.com','mailinator.com','tempmail.com','guerrillamail.com','lycos.com','dreamwiz.com','empas.com','korea.com','chol.com','paran.com',
      'privaterelay.appleid.com','appleid.com',        -- Apple 비공개 릴레이(사용자별 난수 주소) — 소유자 증명이 될 수 없다
      'users.noreply.github.com','noreply.github.com'  -- GitHub 이메일 비공개 설정
    ])
$$;
update public.msgr_orgs set auto_join_domain = null
 where auto_join_domain is not null and public.msgr_public_email_domain(auto_join_domain);
