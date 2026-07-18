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
];

const EMPTY = { fs: false, browser: false, shell: false, bypass: false };

export async function loadCapabilities(wsId) {
  // 능력 토글은 보안 설정 — 손상을 조용히 리셋해 보안 자세를 바꾸지 않고 throw로 드러낸다.
  // 부재(ENOENT)만 EMPTY로 시드된다.
  const caps = { ...EMPTY, ...(await readJson(paths(wsId).capabilities, EMPTY)) };
  // 레거시 bypass:true — 새 2단 모델의 동등값(3능력 켬)으로 1회 이행하고 끈다. DEFS에서 bypass가
  // 빠져 UI/API로 끌 수 없게 된 고착을 방지(검수 MEDIUM). 멱등이라 동시 로드 경합도 무해.
  if (caps.bypass) {
    const migrated = { fs: true, browser: true, shell: true, bypass: false };
    await writeJsonAtomic(paths(wsId).capabilities, migrated).catch(() => { /* 다음 로드가 재시도 */ });
    return migrated;
  }
  return caps;
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
