// 인프로세스 키별 뮤텍스 — read-modify-write(JSON 파일 통째 덮어쓰기)를 직렬화해 lost-update를 막는다.
// 단일 노드 프로세스(프로덕션 기본, 로컬 dev leader) 내 웹·텔레그램 동시 턴이 같은 파일을 경쟁하는 것을 덮는다.
// 크로스 프로세스 완전 직렬화는 P1의 정식 저장소(Supabase) 몫 — 여기서는 같은 프로세스 경합만 해소한다.
const chains = new Map(); // key → 마지막 작업 Promise

/** key 단위로 fn을 직렬 실행. 앞 작업이 끝나야 다음이 시작된다. fn의 반환/예외는 호출자에게 그대로 전달. */
export function withLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  // 앞 작업의 성패와 무관하게 이어지도록 catch로 흡수한 뒤 실행
  const run = prev.then(() => fn(), () => fn());
  // 체인에는 성패를 삼킨 꼬리를 저장(다음 대기자가 앞 예외로 끊기지 않게). 맵 누수 방지로 자기 자신이면 정리.
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.finally(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}
