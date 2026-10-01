// supabase-js는 탭이 다시 보일 때마다 같은 사용자로 SIGNED_IN을 보낸다(auth-js _recoverAndRefresh). 새 로그인으로 받으면
// 앱 전체가 로딩 화면으로 바뀌어 열린 창·입력 중인 내용이 사라지고 공간·업무를 다시 읽는다(9/29 실측) — 같은 사용자면 무시한다.
export const isSameUserEcho = (event, session, { signedIn, uid }) => event === 'SIGNED_IN' && signedIn && !!uid && session?.user?.id === uid;
