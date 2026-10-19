// 본체(Node)의 Supabase 클라이언트 생성기 하나 — 모든 요청의 X-Client-Info 끝에 ' argo/<앱 버전>'(withArgoClientInfo)을 단다.
// 왜 한 곳인가(2026-10-19, #1107 엄격 검수 H1): 옛 앱 사용 중지 장치(20261019135000)는 꼬리 없는 옛 서명(supabase-js 2.110.2, runtime=node) 요청을
// 옛 앱으로 의심한다. 0.1.114에서 결제 화면(rpc my_plan)·e2ee·의견 보내기처럼 꼬리 없이 나가는 요청이 있으면, 0.1.113에서 같은 로그인 그대로 업데이트한
// 세션이 관문 호출 전에 옛 앱으로 오인돼 로그아웃될 수 있었다. 서버 쪽도 막았지만(버전 모르는 관문 세션은 35분 흐름), 꼬리는 모든 요청에 붙인다.
// src/·app/의 서버 코드는 '@supabase/supabase-js'의 createClient를 직접 쓰지 않고 이것을 쓴다 — test/supabase-client-tail.test.mjs가 잠근다.
// 브라우저 코드('use client')는 대상이 아니다(CORS 사전 요청 허용 헤더 — app-version.mjs withArgoClientInfo 주석).
import { createClient } from '@supabase/supabase-js';
import { withArgoClientInfo } from './app-version.mjs';

/** createClient와 같은 모양. opts.global.fetch가 있으면 그것을 감싸고, 없으면 기본 fetch를 감싼다(이미 꼬리가 있으면 그대로). */
export function argoCreateClient(url, key, opts = {}) {
  return createClient(url, key, { ...opts, global: { ...opts?.global, fetch: withArgoClientInfo(opts?.global?.fetch) } });
}
