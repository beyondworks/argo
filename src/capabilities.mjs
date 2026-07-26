// 로컬 능력 토글 — 크루가 워크스페이스 밖 세상(파일·웹·셸)에 손대는 것은 전부 opt-in이다.
// 켜면 그 범위는 결재 없이 바로 실행된다(2026-07-18 모델 단순화 — permission-gate.mjs 주석 참조).
// 이전의 별도 bypass 토글은 잉여가 되어 설정 UI에서 내렸다(저장값은 하위호환으로 보존·무해).
import { paths } from './workspace.mjs';
import { writeJsonAtomic, readJson } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';

export const CAPABILITY_DEFS = [
  ['fs', '파일 시스템', '워크스페이스 밖 파일 읽기/쓰기/편집 — 켜면 결재 없이 바로 실행됩니다'],
  ['browser', '웹 브라우징', '웹 페이지 열람·검색(WebFetch/WebSearch) — 켜면 결재 없이 바로 실행됩니다'],
  ['shell', '셸·컴퓨터', '명령 실행(Bash) — 켜면 결재 없이 바로 실행됩니다'],
  // 바이패스(유건 지시 2026-07-26) — "사람이 판단해야 하는 것만 결재". 도구·능력 같은 준비성 결재는
  // 자동 승인하고, 회사 밖으로 나가는 행동(발송·게시·구매·삭제·계약)과 크루 영입·프로필 변경은
  // 그대로 결재를 받는다. 그 경계는 크루 도구(request_approval)와 프롬프트 결재 규칙이 지킨다.
  ['bypass', '준비 작업 자동 승인', '도구 설치·능력 켜기처럼 준비성 결재를 자동 승인합니다. 이메일 발송·게시·구매·삭제처럼 사람이 판단해야 하는 일은 그대로 결재를 받습니다'],
];

const EMPTY = { fs: false, browser: false, shell: false, bypass: false };

export async function loadCapabilities(wsId) {
  // 능력 토글은 보안 설정 — 손상을 조용히 리셋해 보안 자세를 바꾸지 않고 throw로 드러낸다.
  // 부재(ENOENT)만 EMPTY로 시드된다.
  // bypass는 2026-07-26에 정식 토글로 복귀했다(준비성 결재 자동 승인). 이전의 "레거시 bypass:true를
  // 3능력 켜기로 이행하고 끄던" 마이그레이션은 제거 — 지금은 UI/API로 켜고 끌 수 있어 고착 위험이 없고,
  // 남겨두면 사용자가 켠 설정을 매 로드마다 되돌린다.
  return { ...EMPTY, ...(await readJson(paths(wsId).capabilities, EMPTY)) };
}

export async function updateCapabilities(wsId, patch) {
  return withLock(`capabilities:${wsId}`, async () => {
    const caps = { ...(await loadCapabilities(wsId)) };
    for (const [key] of CAPABILITY_DEFS) {
      if (typeof patch[key] === 'boolean') caps[key] = patch[key];
    }
    await writeJsonAtomic(paths(wsId).capabilities, caps);
    return caps;
  });
}
