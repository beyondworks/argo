// supabase-js는 탭이 다시 보일 때마다 같은 사용자로 SIGNED_IN을 보낸다(auth-js _recoverAndRefresh). 새 로그인으로 받으면
// 앱 전체가 로딩 화면으로 바뀌어 열린 창·입력 중인 내용이 사라지고 공간·업무를 다시 읽는다(9/29 실측) — 같은 사용자면 무시한다.
export const isSameUserEcho = (event, session, { signedIn, uid }) => event === 'SIGNED_IN' && signedIn && !!uid && session?.user?.id === uid;

// 새로고침 없이 다른 계정으로 바뀌면(데스크톱 로그인·다른 탭의 로그인 전달·개발용 비밀번호 로그인) 페이지를 다시 불러온다 — 화면 코드의 모듈 캐시
// (문서함 목록·파일 내용·회사 정보·메일·일정 등)에 남은 앞 계정 데이터가 새 계정 화면에 섞이지 않게(10/4 3차 검수 HIGH: B의 개인 문서함에 A의 파일이 보였다).
// pageUid = 이 페이지에서 처음 데이터를 읽은 계정. 같은 계정으로 다시 로그인하거나 로그아웃만 하면 다시 불러오지 않는다
export const switchNeedsReload = (pageUid, uid) => !!pageUid && !!uid && uid !== pageUid;
