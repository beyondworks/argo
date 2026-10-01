// 서버 존재 표식 — 앱 사이드카가 부팅할 때 데이터 폴더 맨 위에 `.server-presence.json`({pid, at})을 쓰고 종료할 때 지운다(2026-10-01, 설계 2-2·반대 검토 M-c).
// 같은 폴더를 쓰는 argo CLI가 "앱이 실행 중인가"를 알아야 한다 — 앱이 켜진 채 CLI가 로그인 세션을 쓰면 앱의 동기화 루프가 시작되지 않고(부팅 때 한 번만 판단)
// 앱 화면은 여전히 로그인 화면이다. 로그인하지 않은 앱은 동기화 락도 없어서 락 파일로는 못 찾는다. 로그인 셸·포트 조회는 쓰지 않는다.
// 표식에는 pid와 시각뿐 — 경로·계정·토큰이 없다. pid가 다른 프로세스에 재사용되면 "실행 중"으로 오판할 수 있어(드묾), CLI 안내에 이 파일의 위치를 보여 준다.
// 동기화 대상이 아니고(sync EXCLUDE) 크루 셸이 건드릴 수 없다(permission-gate WS_DOT_FILES).
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

export const presenceFile = (root) => join(root, '.server-presence.json');

export function writePresence(root, { pid = process.pid } = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(presenceFile(root), JSON.stringify({ pid, at: Date.now() }));
}

/** 내 표식일 때만 지운다 — 같은 폴더에 다른 서버가 새로 썼다면 그것을 지우지 않는다. */
export function clearPresence(root, { pid = process.pid } = {}) {
  try {
    if (JSON.parse(readFileSync(presenceFile(root), 'utf8'))?.pid !== pid) return;
    rmSync(presenceFile(root), { force: true });
  } catch { /* 없음·깨짐 — 지울 것 없다 */ }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };

/** 살아 있는 **다른** 프로세스의 표식이면 { pid, file }, 아니면 null(없음·깨짐·죽은 pid·내 pid). */
export function serverRunning(root) {
  try {
    const { pid } = JSON.parse(readFileSync(presenceFile(root), 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return null;
    return { pid, file: presenceFile(root) };
  } catch { return null; }
}
