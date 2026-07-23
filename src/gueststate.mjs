// 게스트(로컬 전용) 모드 마커 — devicesession.mjs와 같은 계약: WS_ROOT의 기기 파일이 권한의 근거,
// 쿠키는 미들웨어 UX 게이트일 뿐이다. 인증 빌드(AUTH_ON)에서 로그인 없이 로컬 1인 모드로 쓰는 선택지.
// 실로그인(기기 세션·쿠키 세션)이 있으면 currentUser가 그것을 우선한다 — 게스트는 폴백.
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';
import { writeJsonAtomic } from './jsonstore.mjs';

const FILE = '.guest-mode.json';

export function guestModeOn({ root = WS_ROOT } = {}) {
  try {
    return !!JSON.parse(readFileSync(join(root, FILE), 'utf8'))?.enabled;
  } catch {
    return false; // 부재/손상 = 게스트 아님 (마커는 재생성 가능 — 관용)
  }
}

export async function enableGuestMode({ root = WS_ROOT } = {}) {
  await writeJsonAtomic(join(root, FILE), { enabled: true, ts: new Date().toISOString() });
}

/** 클레임(계정 귀속) 완료 시 호출 — 이후 currentUser는 실로그인 경로만 탄다. */
export async function clearGuestMode({ root = WS_ROOT } = {}) {
  await rm(join(root, FILE), { force: true });
}
