// 키별 뮤텍스 — read-modify-write(JSON 파일 통째 덮어쓰기)를 직렬화해 lost-update를 막는다.
// 기본은 인프로세스(단일 노드 프로세스 내 웹·텔레그램 동시 턴). 같은 데이터 폴더를 **여러 프로세스**가 쓰면(앱 사이드카·argo CLI·상주,
// 2026-10-01 앱 통합) 인프로세스 체인은 서로를 모른다 — 그래서 withLock에 `file`을 주면 그 파일 옆 `<file>.lockd` 디렉터리 잠금을 함께 잡는다.
// 파일이 아닌 것(턴 직렬화·메모리 상태)은 file 없이 쓴다.
const chains = new Map(); // key → 마지막 작업 Promise

/** key 단위로 fn을 직렬 실행. 앞 작업이 끝나야 다음이 시작된다. fn의 반환/예외는 호출자에게 그대로 전달.
    opts.file: 이 작업이 읽고-고쳐-쓰는 파일 경로 — 주면 프로세스 간 잠금(`<file>.lockd`)을 인프로세스 순서 **안쪽**에서 잡는다
    (같은 프로세스의 대기자는 디렉터리 잠금을 두고 경쟁하지 않고 체인에서 줄을 선다). 같은 파일은 어느 호출부든 같은 경로 문자열을 써야 한다.
    잠금 안에서 같은 파일의 다른 잠금을 다시 잡으면(중첩) 교착이다 — 인프로세스 체인과 같은 제약이다.
    opts.mkParent=false: 파일 폴더가 없으면 잠금 없이 fn을 실행한다(없는 회사에 유령 폴더를 만들지 않으려고 — company.json·크루 카드). */
export function withLock(key, fn, opts = {}) {
  const { file = null, mkParent = true, ...dirOpts } = opts;
  const body = file ? () => withFileLock(file, fn, { mkParent, ...dirOpts }) : fn;
  const prev = chains.get(key) ?? Promise.resolve();
  // 앞 작업의 성패와 무관하게 이어지도록 catch로 흡수한 뒤 실행
  const run = prev.then(() => body(), () => body());
  // 체인에는 성패를 삼킨 꼬리를 저장(다음 대기자가 앞 예외로 끊기지 않게). 맵 누수 방지로 자기 자신이면 정리.
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.finally(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

/** 파일 하나의 프로세스 간 잠금 — 살아 있는 주인은 10초마다 잠금 폴더 시각을 갱신해 오래 걸려도 회수되지 않고(회수 30초는 크래시 주인뿐),
    기다리는 쪽은 40초까지 기다린다(> 회수 30초 — 주인 없는 잠금이 남아도 회수 뒤 진행). */
export async function withFileLock(file, fn, { mkParent = true, staleMs = 30_000, timeoutMs = 40_000, refreshMs = 10_000, ...rest } = {}) {
  if (!mkParent) {
    const { existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    if (!existsSync(dirname(file))) return fn(); // 폴더가 없으면 보호할 파일도 없다
  }
  return withDirLock(`${file}.lockd`, fn, { staleMs, timeoutMs, refreshMs, mkParent, ...rest });
}

/** **크로스 프로세스** 디렉터리 락 — mkdir은 모든 OS에서 배타적이다(crewmail 선점·devicesession 회전과
    같은 원시 연산). 자격 파일(.secrets.json·codex auth.json·grok 토큰)의 read-modify-write를 상주·앱
    사이드카·CLI 러너 자식이 동시에 건드리는 것을 막는다 — Hermes(hermes_cli/auth.py)가 인증 저장소 I/O를
    "cross-process flock + atomic write" 두 원시 연산으로만 하는 것과 같은 불변식(2026-09-05 러너 견고화).
    잔재 락(프로세스 크래시)은 staleMs가 지나면 회수한다. 락 획득 실패는 timeoutMs 뒤 ELOCKTIMEOUT로 던진다
    — 조용히 진행하면 이 함수가 존재할 이유가 없다. 락 디렉터리의 부모는 있어야 한다(자격 파일 옆에 둔다). */
export async function withDirLock(lockDir, fn, { staleMs = 30_000, retryMs = 25, timeoutMs = 10_000, refreshMs = 0, mkParent = true, _hooks = null } = {}) {
  const { mkdir, rm, stat, utimes } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  // 부모가 없으면 만든다(분리 검수 MEDIUM-4): 회사 디렉터리가 아직 없는 wsId의 첫 저장(writeJsonAtomic은 mkdir -p)이
  // 락 mkdir(non-recursive)에서 ENOENT로 죽던 회귀 — 락은 보호 대상 파일보다 먼저 생기므로 부모 보장은 락의 몫.
  if (mkParent) await mkdir(dirname(lockDir), { recursive: true }).catch(() => {});
  const t0 = Date.now();
  for (;;) {
    try { await mkdir(lockDir); break; } catch (e) {
      // Windows can report EPERM while another process's removed directory is
      // delete-pending. Retry within the same budget, without reclaiming that lock.
      if (e?.code !== 'EEXIST' && !(process.platform === 'win32' && e?.code === 'EPERM')) throw e;
      let reclaimed = false;
      try {
        if (e.code === 'EEXIST' && Date.now() - (await stat(lockDir)).mtimeMs > staleMs) reclaimed = await reclaimStale(lockDir, staleMs, { mkdir, rm, stat }, _hooks);
      } catch { /* 방금 사라짐 — 다음 루프가 다시 시도 */ }
      if (reclaimed) continue;
      if (Date.now() - t0 > timeoutMs) throw Object.assign(new Error(`lock timeout: ${lockDir}`), { code: 'ELOCKTIMEOUT' });
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  // refreshMs: 잠금을 쥔 동안 잠금 폴더 시각을 갱신한다 — 오래 걸리는 작업(기기 세션 회전)을 살아 있는 주인이 하는 동안
  // 다른 프로세스가 staleMs로 회수하지 않게. 회수는 갱신이 멈춘 주인(크래시)에게만 일어난다. 기본 0 = 갱신 없음(종전 동작).
  const beat = refreshMs > 0 ? setInterval(() => { const now = new Date(); utimes(lockDir, now, now).catch(() => {}); }, refreshMs) : null;
  beat?.unref?.();
  try { return await fn(); } finally {
    if (beat) clearInterval(beat);
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 오래된 잠금 회수 — 회수 전용 2차 잠금(<lock>.reclaim) 안에서 **다시** stat하고 여전히 오래됐을 때만 지운다.
    없으면 두 프로세스가 같은 오래된 잠금을 보고 각자 stat → rm 하다가, 늦게 rm한 쪽이 먼저 회수해 새로 잡은 잠금까지 지워
    둘이 동시에 잠금 안에 들어갔다(#791 독립 검수 MEDIUM-3 — 2개 60회 중 7회 겹침). 2차 잠금 자체가 크래시로 남으면 같은 기준으로 치운다.
    반환: 회수했는가(true면 호출부가 곧바로 다시 mkdir을 시도).
    _hooks.beforeGuard: 테스트 전용 — "오래됐다고 본 뒤 2차 잠금을 잡기 전"에 멈춰, 다른 프로세스가 회수·재획득을 끝낸 뒤에
    2차 잠금을 늦게 얻는 순서를 결정적으로 만든다(test/mutex-reclaim-race.test.mjs). 프로덕션 호출부는 넘기지 않는다. */
async function reclaimStale(lockDir, staleMs, { mkdir, rm, stat }, _hooks = null) {
  if (_hooks?.beforeGuard) await _hooks.beforeGuard();
  const guard = `${lockDir}.reclaim`;
  try { await mkdir(guard); } catch (e) {
    if (e?.code === 'EEXIST') {
      try { if (Date.now() - (await stat(guard)).mtimeMs > staleMs) await rm(guard, { recursive: true, force: true }); } catch { /* 방금 사라짐 */ }
    }
    return false; // 다른 프로세스가 회수 중 — 다음 루프에서 다시 본다
  }
  try {
    if (Date.now() - (await stat(lockDir)).mtimeMs <= staleMs) return false; // 그사이 누가 새로 잡았다 — 지우지 않는다
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } catch { return false; } finally { await rm(guard, { recursive: true, force: true }).catch(() => {}); }
}
