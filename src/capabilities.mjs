// 로컬 능력 토글 — 크루가 워크스페이스 밖 세상(파일·웹·셸)에 손대는 것은 전부 opt-in이다.
// bypass(권한 우회)가 꺼져 있으면 부작용 있는 도구는 결재 게이트에서 사람 승인을 기다린다.
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';

export const CAPABILITY_DEFS = [
  ['fs', '파일 시스템', '워크스페이스 밖 파일 읽기/쓰기/편집 — 문서 정리, 폴더 관리'],
  ['browser', '웹 브라우징', '웹 페이지 열람·검색(WebFetch/WebSearch) — 조사, 링크 확인'],
  ['shell', '셸·컴퓨터', '명령 실행(Bash) — 스크립트, 앱 실행, 시스템 작업'],
  ['bypass', '권한 우회 모드', '위 능력을 결재 없이 즉시 실행 — 신뢰하는 회사에서만'],
];

const EMPTY = { fs: false, browser: false, shell: false, bypass: false };

export async function loadCapabilities(wsId) {
  // 능력 토글(특히 bypass)은 보안 설정 — 손상을 조용히 리셋해 보안 자세를 바꾸지 않고 throw로 드러낸다.
  // 부재(ENOENT)만 EMPTY로 시드된다.
  return { ...EMPTY, ...(await readJson(paths(wsId).capabilities, EMPTY)) };
}

export async function updateCapabilities(wsId, patch) {
  const caps = { ...(await loadCapabilities(wsId)) };
  for (const [key] of CAPABILITY_DEFS) {
    if (typeof patch[key] === 'boolean') caps[key] = patch[key];
  }
  await writeJsonAtomic(paths(wsId).capabilities, caps);
  return caps;
}
