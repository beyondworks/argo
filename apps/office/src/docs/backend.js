// 문서·전자서명 저장소 고르기 — 예시 데이터 모드는 이 브라우저(backend-sample-browser.js), 로그인 모드는 Supabase(backend-live.js).
// 둘 다 같은 함수 이름·같은 모양을 돌려준다(화면은 구분하지 않는다). 각자 처음 쓸 때만 불러온다.
import { getMode } from '../core/session.js';

let pending = null;
export function backend() {
  pending ??= (getMode() === 'sample' ? import('./backend-sample-browser.js') : import('./backend-live.js')).then((m) => m.default).catch((e) => { pending = null; throw e; });
  return pending;
}
