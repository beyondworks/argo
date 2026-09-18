// 알림 권한 판정 — notify.js의 분기를 떼어 둔 순수 함수(노드 테스트로 행동을 잠근다, 검수 #604 MEDIUM).
// native: null = 맥 데스크톱이 아님 / { ok: true, value } / { ok: false, error }. fallback: 플러그인·웹 경로. reread: 네이티브 상태 다시 읽기.
// 플러그인 2.4.0 데스크톱은 권한을 늘 Granted로 답한다 — 맥에서 네이티브가 실패했다고 플러그인으로 내려가면 거짓 "허용"이 된다
// (권한 창을 오래 두어 시간 초과 → "알림 켜짐" 표시, askNotifyOnce도 묻지 않음). 그래서 플러그인은 맥이 아니거나 번들 밖('unsupported')일 때만.
export async function resolvePermission(native, fallback, reread = null) {
  if (native === null) return fallback();
  if (native.ok) return native.value === 'unsupported' ? fallback() : native.value;
  if (reread) { const r = await reread(); if (r?.ok && r.value !== 'unsupported') return r.value; }
  return 'default'; // 모르면 "아직 안 정함" — 켜기 버튼·첫 요청이 다시 기회를 준다
}
