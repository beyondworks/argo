// register(new URL('./helpers/next-headers-stub-resolve.mjs', import.meta.url)) — 'next/headers'를 위 대역으로 푼다.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/headers') return { url: new URL('./next-headers-stub.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
