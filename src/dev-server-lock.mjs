// 같은 저장소의 Next 개발 서버가 하나의 distDir를 동시에 쓰지 않게 하는 프로세스 락.
// 락은 OS 임시 폴더에 두므로 저장소를 더럽히지 않고, 비정상 종료 뒤에는 PID 확인으로 회수한다.
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const STARTING_GRACE_MS = 5000;

const readOwner = (lockPath) => {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); }
  catch { return null; }
};

export function processIsAlive(pid, signal = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    signal(pid, 0);
    return true;
  } catch (error) {
    // EPERM은 프로세스가 있지만 신호 권한만 없다는 뜻이다.
    return error?.code === 'EPERM';
  }
}

/** 원자적인 wx 생성으로 선점한다. 이미 살아 있는 소유자가 있으면 파일을 건드리지 않는다. */
export function acquireDevServerLock(lockPath, owner, { isAlive = processIsAlive, now = Date.now } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(owner), 'utf8');
      return { acquired: true, owner };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readOwner(lockPath);
      if (current && isAlive(current.pid)) return { acquired: false, owner: current, reason: 'running' };

      // 다른 프로세스가 wx로 막 파일을 만든 직후라 아직 JSON이 비어 있을 수 있다.
      // 이 짧은 창에서는 삭제하지 않고 "기동 중"으로 처리한다.
      if (!current) {
        try {
          if (now() - statSync(lockPath).mtimeMs < STARTING_GRACE_MS) {
            return { acquired: false, owner: null, reason: 'starting' };
          }
        } catch { /* 검사 사이에 사라졌으면 아래에서 재시도 */ }
      }
      try { rmSync(lockPath, { force: true }); } catch { /* 다음 wx 시도가 최종 판정 */ }
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return { acquired: false, owner: readOwner(lockPath), reason: 'contended' };
}

/** 후속 프로세스의 새 락을 지우지 않도록 소유 토큰이 일치할 때만 해제한다. */
export function releaseDevServerLock(lockPath, token) {
  const current = readOwner(lockPath);
  if (!current || current.token !== token) return false;
  try {
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}
