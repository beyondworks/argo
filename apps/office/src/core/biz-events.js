// 업무 쓰기 알림(OFC-10) — 업무 클라이언트(business/data.js·예시 sample-business.js)가 쓰기에 성공하면 'office:biz-written'(detail = 동작 이름)을 보낸다.
// 거래처를 만들거나 고쳤으면(customer.*) 문서함·일정이 들고 있던 거래처 목록만 비운다 — 다음에 그 화면을 열 때 한 번 다시 읽는다(쓰기마다 읽지 않는다).
// office:biz-refresh(마케팅이 매번 서버를 다시 읽는 사건)와 따로 둔다. 업무 클라이언트는 이 파일을 들여오지 않는다(테스트가 그 파일을 가져오기 없이 실행한다)
export const BIZ_WRITTEN = 'office:biz-written';
export const onCustomersChanged = (fn) => globalThis.addEventListener?.(BIZ_WRITTEN, (e) => { if (/^customer\./.test(String(e?.detail ?? ''))) fn(); });
