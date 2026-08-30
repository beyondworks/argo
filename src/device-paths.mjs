// 기기 종속 절대경로 감지 — 루틴 이식성 안내용(윈도 실기기 관찰 2026-08-30: 루틴 prompt에
// 맥 절대경로가 박혀 있으면, 클라우드 리더가 다른 기기로 옮겨간 날 그 루틴이 조용히 실행 불가가 된다.
// 리더 선정은 사용자 통제 밖 — src/scheduler.mjs isCloudLeader). 저장을 막지 않는 정직 안내가 목적이라
// 감지는 보수적으로: 확실한 OS 절대경로만 잡고, URL·상대경로·회사 폴더 경로는 잡지 않는다.
// 노드 의존 0 — 서버(src)와 화면(app) 양쪽에서 같은 판정을 쓴다(로직 이원화 금지).

// 잡는 것: 맥(/Users/·/Volumes/), 리눅스(/home/·/root/), 윈도(C:\ 드라이브·\\UNC).
// 경로 앞은 줄 시작·공백·인용부호·괄호·= 만 허용 — 단어 중간(슬래시 포함 일반 텍스트) 오탐 방지.
const DEVICE_PATH_RE = /(^|[\s"'`(=])((?:\/Users\/|\/home\/|\/root\/|\/Volumes\/)[^\s"'`)]+|[A-Za-z]:\\[^\s"'`)]+|\\\\[^\s"'`)]+)/gm;

/** 텍스트에서 기기 종속 절대경로를 감지해 예시 목록(최대 3, 중복 제거)을 돌려준다.
    URL(스킴://…)은 경로가 아니므로 검사 전에 걷어낸다 — https://example.com/Users/docs 오탐 방지. */
export function detectDevicePaths(text) {
  const cleaned = String(text ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const found = [];
  for (const m of cleaned.matchAll(DEVICE_PATH_RE)) {
    const p = m[2].replace(/[),.;:!?]+$/, ''); // 문장 속 경로 끝의 구두점은 경로가 아니다 — 예시 표기 품질
    if (!found.includes(p)) found.push(p);
    if (found.length >= 3) break;
  }
  return found;
}
