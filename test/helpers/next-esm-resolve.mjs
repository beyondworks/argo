// Next 라우트를 plain node 테스트에서 실임포트하기 위한 리졸브 훅.
// "라우트 실호출은 next/headers 때문에 불가"라던 기존 관례의 실체는 임포트 실패가 아니라
// **ESM 확장자 해석**이었다 — next의 exports 맵 밖(plain node)에선 'next/headers'가
// 'next/headers.js'로만 풀린다(실측 2026-08-29, node 22 오류 제안문 그대로).
// 사용법: 테스트 파일에서 register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url))
// 후 라우트를 동적 임포트한다. node --test는 파일별 자식 프로세스라 다른 테스트로 새지 않는다.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') return nextResolve('next/headers.js', context);
  if (specifier === 'next/server') return nextResolve('next/server.js', context); // middleware.js 실호출(test/middleware-mobile-*.test.mjs)
  return nextResolve(specifier, context);
}
