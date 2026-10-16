// 메신저 기록 옮기기 실행부 — 앱 시작 때 한 번 자동 실행(instrumentation-node.mjs), 설정 화면의 상태 조회·재시도(app/api/companies/[ws]/msgr-archive).
// 핵심 받기는 src/msgr-archive.mjs. 여기서는 ① 어느 회사·폴더에 둘지 ② 프로세스 안에서 한 번에 하나만 돌기 ③ 자동 실행 조건만 다룬다.
// 보관 폴더는 계정 기준 <WS_ROOT>/.msgr-archive/<uid8>/(회사 폴더 밖 — msgr-archive.mjs 머리 주석). 기기 등록부 <WS_ROOT>/.msgr-archive.json = { [uid]: { ws, dir } }
//   ws = 처음 받은 회사 id(화면 안내의 '설정에서 보기' 자리 — 그 회사를 보관·이름 변경해도 기록 위치는 그대로), dir = 보관 폴더 안 계정 폴더 이름.
import { join } from 'node:path';
import { WS_ROOT, paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { runArchive, readArchiveState, archiveDirFor, pickCompany, pauseState, ARCHIVE_DIR, PARTIAL_RETRY_MAX } from './msgr-archive.mjs';

const REGISTRY = () => join(WS_ROOT, '.msgr-archive.json');
const RUN = (globalThis.__argoMsgrArchiveRun ??= { promise: null, ws: null, uid: null }); // Next 번들 사본이 갈려도 하나(globalThis)

const defaultSession = async () => (await import('./gateway/msgr.mjs')).sessionClient();
const defaultCompanies = async () => (await import('./hub.mjs')).listCompanies();

async function registry() { try { return await readJson(REGISTRY(), {}); } catch { return {}; } }

/** 이 계정의 보관 폴더와 안내할 회사. 처음이면 이 계정이 주인인 회사가 있어야 한다(Argo를 쓰는 사람만 받는다 — 회사가 없으면 null).
    한 번 정하면 등록부를 따른다 — 그 회사를 보관·삭제해도 기록은 계정 폴더에 그대로 있고 다시 받지 않는다. */
export async function archiveTarget(uid, { ws = null, companies = defaultCompanies } = {}) {
  const reg = await registry();
  if (reg[uid]?.dir) return { ws: reg[uid].ws ?? null, dir: join(WS_ROOT, ARCHIVE_DIR, reg[uid].dir) };
  const pick = ws ?? pickCompany(await companies(), uid);
  if (!pick) return null;
  return { ws: pick, dir: await archiveDirFor(WS_ROOT, uid) };
}

async function remember(uid, target) {
  const reg = await registry();
  if (reg[uid]?.dir) return;
  reg[uid] = { ws: target.ws, dir: target.dir.slice(join(WS_ROOT, ARCHIVE_DIR).length + 1) };
  await writeJsonAtomic(REGISTRY(), reg);
}

/** 받기 시작(이미 도는 중이면 그 실행을 돌려준다). 끝난 계정은 요청 없이 끝난 상태를 돌려준다.
    자리 잡기는 await 전에 한다 — 앱 시작 자동 실행과 설정 POST가 겹쳐도 실행은 하나(같은 폴더에 두 실행이 덧붙이지 않게, 분리 검수 낮음-4).
    session = 받는 도중 토큰이 바뀌면 새 클라이언트를 줄 함수(기기 세션 회전 — 분리 검수 높음-1). */
export async function startArchive({ c, ws = null, companies = defaultCompanies, run = runArchive, session = defaultSession } = {}) {
  if (RUN.promise) return { started: false, running: true, ws: RUN.ws };
  let started;
  const startInfo = new Promise((r) => { started = r; });
  RUN.uid = c.uid;
  RUN.promise = (async () => {
    const target = await archiveTarget(c.uid, { ws, companies });
    if (!target) { started({ started: false, reason: 'noCompany' }); return null; }
    await remember(c.uid, target);
    RUN.ws = target.ws;
    // getClient — 같은 계정의 새 토큰만. 받는 도중 로그인이 다른 계정으로 바뀌면 null(인증 실패 → failed로 남는다). B의 토큰으로 A의 방을 물으면 빈 목록이 와 done으로 굳는다(재검수 낮음)
    const getClient = async () => { const s = await session().catch(() => null); return s?.uid === c.uid ? s.client : null; };
    const p = run({ client: c.client, getClient, uid: c.uid, dir: target.dir });
    started({ started: true, ws: target.ws });
    return await p;
  })()
    .catch((e) => { console.error('[argo] 메신저 기록 옮기기 실패:', e?.message ?? e); started({ started: false, reason: 'error' }); return null; })
    .finally(() => { RUN.promise = null; RUN.ws = null; RUN.uid = null; });
  const info = await startInfo;
  return info.started ? { ...info, promise: RUN.promise } : info;
}

/** 자동 실행 조건(앱 시작 때 한 번): 로그인함 + 중단 스위치 켜짐 + 이 계정 기록이 없거나 중간에 끊김(running·failed). 끝남은 다시 돌지 않는다.
    일부 실패(partial)는 스위치와 상관없이 못 받은 첨부만 다시 받는다(읽기는 늘 열려 있다, 설정 단추가 없어졌으므로) — PARTIAL_RETRY_MAX번 뒤에는 더 시도하지 않는다(요청 0). */
export async function maybeAutoArchive({ session = defaultSession, companies = defaultCompanies, run = runArchive } = {}) {
  const c = await session().catch(() => null);
  if (!c) return { ran: false, reason: 'noSession' };
  const target = await archiveTarget(c.uid, { companies });
  const st = target ? await readArchiveState(target.dir) : null;
  if (st?.uid === c.uid && st.status === 'done') return { ran: false, reason: 'already' }; // 끝난 계정은 스위치도 읽지 않는다(요청 0)
  if (st?.uid === c.uid && st.status === 'partial') {
    if (st.gaveUp || (st.partialRetries ?? 0) >= PARTIAL_RETRY_MAX) return { ran: false, reason: 'gaveUp' }; // 상한을 넘었다(요청 0)
    const r = await startArchive({ c, companies, run, session }); // 스위치 RPC 없이 — 못 받은 첨부만(runArchive가 partial이면 retryPartial로 간다)
    if (r.promise) await r.promise;
    return { ran: !!r.started, ws: r.ws, retry: true };
  }
  const pause = await pauseState(c.client);
  if (!pause.paused) return { ran: false, reason: pause.error ? 'pauseUnknown' : 'notPaused' };
  if (!target) return { ran: false, reason: 'noCompany' };
  const r = await startArchive({ c, companies, run, session });
  if (r.promise) await r.promise;
  return { ran: !!r.started, ws: r.ws };
}

/** 설정 화면이 보는 상태 — 로컬 파일만 읽는다(요청 0). 스위치 값은 캐시(앱 시작·이 화면 첫 조회 때 읽은 값). */
export async function archiveStatus(uid, ws, { companies = defaultCompanies } = {}) {
  const target = await archiveTarget(uid, { companies });
  const st = target ? await readArchiveState(target.dir) : null;
  const running = !!RUN.promise && RUN.uid === uid;
  return {
    ws: target?.ws ?? null, dir: target && st ? target.dir : null, // 계정 폴더라 어느 회사 화면에서든 같은 기록을 보인다
    status: running ? 'running' : st?.uid === uid ? (st.status === 'running' ? 'interrupted' : st.status) : 'none',
    totals: st?.totals ?? null, failed: st?.failed?.length ?? 0, finishedAt: st?.finishedAt ?? null, error: st?.error ?? null, gaveUp: !!st?.gaveUp, // gaveUp — 못 받은 첨부를 상한까지 시도했다(안내가 '다음에 다시 받습니다'를 말하지 않는다)
  };
}

export const _runState = RUN; // 시험용
