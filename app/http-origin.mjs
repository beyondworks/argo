// 프록시 뒤 공개 주소 복원 — Next standalone은 req.url의 origin을 내부 바인드 주소(0.0.0.0:8080)로
// 만들 수 있다(HOSTNAME env 기반). Fly 등 리버스 프록시가 주는 x-forwarded-host/proto를 우선해
// 사용자에게 보이는 origin으로 리다이렉트를 만든다. 로컬 직결(포워드 헤더 없음)은 기존 동작 그대로.
export function publicUrl(req, path) {
  const h = req.headers;
  const host = h.get('x-forwarded-host') || h.get('host');
  const proto = h.get('x-forwarded-proto') || 'http';
  if (host) return new URL(path, `${proto}://${host}`);
  return new URL(path, req.url);
}
