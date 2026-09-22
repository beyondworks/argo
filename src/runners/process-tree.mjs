// Cancellation owns one spawned CLI and its descendants, never a command name or user-wide process set.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

async function processTable() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,lstart='], { timeout: 2000, maxBuffer: 2e6, windowsHide: true });
  return new Map(stdout.split('\n').flatMap(line => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    return m ? [[Number(m[1]), { pid: Number(m[1]), parent: Number(m[2]), birth: m[3] }]] : [];
  }));
}
const signalPid = (pid, signal) => { try { process.kill(pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } };

// One shared snapshot per 500ms while CLI turns are active, no per-crew polling process.
const watchers = new Set(); let watchTimer = null, inspection = null;
function refreshOwnership() {
  if (inspection || !watchers.size) return inspection;
  inspection = processTable().then(table => {
    for (const { child, records } of watchers) {
      const root = table.get(child.pid);
      if (root?.parent === process.pid && child.exitCode === null && child.signalCode === null) records.set(root.pid, root);
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of table.values()) {
          if (records.has(record.pid) || !records.has(record.parent)) continue;
          if (table.get(record.parent)?.birth !== records.get(record.parent).birth) continue;
          records.set(record.pid, record); changed = true;
        }
      }
    }
  }).catch(() => {}).finally(() => { inspection = null; });
  return inspection;
}
export function watchOwnedProcessTree(child) {
  const entry = { child, records: new Map() };
  if (process.platform !== 'win32') {
    watchers.add(entry);
    if (!watchTimer) { watchTimer = setInterval(refreshOwnership, 500); watchTimer.unref?.(); }
    refreshOwnership();
  }
  return { records: entry.records, async stop() {
    await inspection; watchers.delete(entry);
    if (!watchers.size) { clearInterval(watchTimer); watchTimer = null; }
  } };
}

export async function terminateOwnedProcessTree(child, ownership = null) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;
  await ownership?.stop();
  const rootExited = child.exitCode !== null || child.signalCode !== null;
  if (process.platform === 'win32') {
    if (rootExited) throw Object.assign(new Error('The runner exited before its descendants could be verified.'), { ownershipUnverified: true });
    await execFileP('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    return;
  }
  let table = await processTable();
  const root = table.get(pid);
  let rootVerified = false;
  const owned = new Map([...ownership?.records ?? []].filter(([id, record]) => id !== pid && table.get(id)?.birth === record.birth));
  if (!rootExited && root?.parent === process.pid) {
    const fresh = (await processTable()).get(pid);
    if (fresh?.birth === root.birth && fresh?.parent === process.pid && child.exitCode === null && child.signalCode === null) { owned.set(pid, root); rootVerified = true; }
    else owned.delete(pid);
  }
  if (!owned.size) {
    throw Object.assign(new Error('The runner process identity could not be verified.'), { ownershipUnverified: true });
  }
  try {
    for (const id of owned.keys()) signalPid(id, 'SIGSTOP');
    for (let round = 0; round < 4; round++) {
      table = await processTable();
      let added = false, changed = true;
      while (changed) {
        changed = false;
        for (const record of table.values()) {
          if (owned.has(record.pid) || !owned.has(record.parent)) continue;
          if (table.get(record.parent)?.birth !== owned.get(record.parent).birth) continue;
          owned.set(record.pid, record); added = changed = true;
          signalPid(record.pid, 'SIGSTOP');
        }
      }
      if (!added) break;
    }
  } finally {
    // Inspection failure must not leave the known frozen processes suspended.
    let inspectionError;
    const current = await processTable().catch(e => { inspectionError = e; return table; });
    let killError;
    for (const record of [...owned.values()].reverse()) {
      if (current.get(record.pid)?.birth === record.birth) {
        try { signalPid(record.pid, 'SIGKILL'); } catch (e) { killError ??= e; }
      }
    }
    if (inspectionError || killError) throw inspectionError ?? killError;
  }
  // A departed root may have launched children between snapshots; never claim those were verified.
  if (!rootVerified) throw Object.assign(new Error('Known child processes stopped; unobserved descendants could not be verified.'), { ownershipUnverified: true });
}

/** execFile-compatible result, with cancellation/timeout that ends commands spawned by the CLI too. */
export function execTurnFile(command, args, options = {}) {
  const { signal, timeout = 0, input, ...rest } = options;
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('중단됨'), { aborted: true }));
  let child, timer, exitGrace, ownership, stopping = false, settled = false, finish;
  const onAbort = () => cancel(false);
  const cancel = (timeoutReached = false) => {
    if (stopping || settled) return;
    stopping = true;
    const reason = Object.assign(new Error(timeoutReached ? 'Runner timed out' : '중단됨'), timeoutReached ? { killed: true, timedOut: true } : { aborted: true });
    // Settle independently of execFile's close callback: a surviving descendant may keep stdio open.
    terminateOwnedProcessTree(child, ownership).then(() => finish(reason), error => {
      reason.cause = error; reason.cancellationIncomplete = true;
      if (!error.ownershipUnverified) try { child.kill('SIGKILL'); } catch { /* already ended */ }
      finish(reason);
    });
  };
  const promise = new Promise((resolve, reject) => {
    finish = (error, stdout, stderr) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(exitGrace); ownership?.stop(); signal?.removeEventListener('abort', onAbort);
      if (error) return reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }));
      resolve({ stdout, stderr });
    };
    child = execFile(command, args, { windowsHide: true, ...rest }, (error, stdout, stderr) => {
      if (!stopping) finish(error, stdout, stderr);
    });
    ownership = watchOwnedProcessTree(child);
    // 루트가 끝났는데 3초 안에 close가 없으면 손자가 stdio를 물고 있는 것이다(K12) — 전엔 상한(30분)까지 기다려
    // 성공 결과를 버리고 "시간 초과"가 됐다. 소유 트리를 최선 종료하고(루트가 이미 나가 확인 불가 오류는 삼킨다)
    // stdio를 끊어 execFile 콜백이 루트가 낸 출력·종료 코드로 발화하게 한다. 중단·시간 초과가 먼저면 그쪽이 이긴다.
    child.once?.('exit', () => {
      exitGrace = setTimeout(() => {
        if (stopping || settled) return;
        terminateOwnedProcessTree(child, ownership).catch(() => {}).finally(() => {
          if (stopping || settled) return;
          child.stdout?.destroy(); child.stderr?.destroy();
        });
      }, 3000);
      exitGrace.unref?.();
    });
    // input — 명령줄 길이 상한(Windows 32,767자·Linux 인자당 128KB)을 넘는 프롬프트를 표준 입력으로 준다(K01).
    // 자식이 다 읽기 전에 끝나면 EPIPE가 난다 — 성패 판정은 execFile 콜백이 하므로 여기선 삼킨다.
    if (input != null) child.stdin?.on('error', () => {});
    child.stdin?.end(input);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (timeout > 0) { timer = setTimeout(() => cancel(true), timeout); timer.unref?.(); }
  });
  promise.child = child;
  promise.ownership = ownership; // 읽기 전용 — 시험이 "루트 종료 전에 관찰됨"을 시간 대신 기록으로 기다린다(병렬 부하에서 500ms 스냅샷이 늦으면 650ms 시계로는 관찰을 놓쳤다)
  return promise;
}
