// 메신저 기록 옮기기 실행부 — 앱 시작 때 한 번 자동 실행(instrumentation-node.mjs), 설정 화면의 상태 조회·재시도(app/api/companies/[ws]/msgr-archive).
// 핵심 받기는 src/msgr-archive.mjs. 여기서는 ① 어느 회사·폴더에 둘지 ② 프로세스 안에서 한 번에 하나만 돌기 ③ 자동 실행 조건만 다룬다.
// 기기 등록부 <WS_ROOT>/.msgr-archive.json = { [uid]: { ws, dir } } — 회사가 여럿이어도 한 계정의 기록은 한 회사에 한 벌만 받는다(다른 회사 설정 화면은 그 위치를 보인다).
import { join } from 'node:path';
import { WS_ROOT, paths } from './workspace.mjs';
import { readJson, writeJsonAtomic } from './jsonstore.mjs';
import { runArchive, readArchiveState, archiveDirFor, pickCompany, pauseState } from './msgr-archive.mjs';

const REGISTRY = () => join(WS_ROOT, '.msgr-archive.json');
const RUN = (globalThis.__argoMsgrArchiveRun ??= { promise: null, ws: null, uid: null }); // Next 번들 사본이 갈려도 하나(globalThis)

const defaultSession = async () => (await import('./gateway/msgr.mjs')).sessionClient();
const defaultCompanies = async () => (await import('./hub.mjs')).listCompanies();

async function registry() { try { return await readJson(REGISTRY(), {}); } catch { return {}; } }

/** 이 계정의 기록이 있는(또는 둘) 회사·폴더. ws를 주면 등록부에 없을 때 그 회사로 정한다(설정 화면에서 시작). */
export async function archiveTarget(uid, { ws = null, companies = defaultCompanies } = {}) {
  const reg = await registry();
  if (reg[uid]?.ws) return { ws: reg[uid].ws, dir: join(paths(reg[uid].ws).root, reg[uid].dir) };
  const pick = ws ?? pickCompany(await companies(), uid);
  if (!pick) return null;
  const dir = await archiveDirFor(paths(pick).root, uid);
  return { ws: pick, dir };
}

async function remember(uid, target) {
  const reg = await registry();
  if (reg[uid]?.ws) return;
  reg[uid] = { ws: target.ws, dir: target.dir.slice(paths(target.ws).root.length + 1) };
  await writeJsonAtomic(REGISTRY(), reg);
}

/** 받기 시작(이미 도는 중이면 그 실행을 돌려준다). 끝난 계정은 요청 없이 끝난 상태를 돌려준다. */
export async function startArchive({ c, ws = null, companies = defaultCompanies, run = runArchive } = {}) {
  if (RUN.promise) return { started: false, running: true, ws: RUN.ws };
  const target = await archiveTarget(c.uid, { ws, companies });
  if (!target) return { started: false, reason: 'noCompany' };
  if (ws && target.ws !== ws) { // 다른 회사(먼저 정한 곳)에 받는다 — 한 계정 한 벌
    const st = await readArchiveState(target.dir);
    if (st?.status === 'done') return { started: false, ws: target.ws, state: st };
  }
  await remember(c.uid, target);
  RUN.ws = target.ws; RUN.uid = c.uid;
  RUN.promise = run({ client: c.client, uid: c.uid, dir: target.dir })
    .catch((e) => { console.error('[argo] 메신저 기록 옮기기 실패:', e?.message ?? e); return null; })
    .finally(() => { RUN.promise = null; RUN.ws = null; RUN.uid = null; });
  return { started: true, ws: target.ws, promise: RUN.promise };
}

/** 자동 실행 조건(앱 시작 때 한 번): 로그인함 + 중단 스위치 켜짐 + 이 계정 기록이 없거나 중간에 끊김(running·failed). 끝남·일부 실패(partial)는 다시 돌지 않는다(재시도는 설정 단추). */
export async function maybeAutoArchive({ session = defaultSession, companies = defaultCompanies, run = runArchive } = {}) {
  const c = await session().catch(() => null);
  if (!c) return { ran: false, reason: 'noSession' };
  const target = await archiveTarget(c.uid, { companies });
  const st = target ? await readArchiveState(target.dir) : null;
  if (st?.uid === c.uid && (st.status === 'done' || st.status === 'partial')) return { ran: false, reason: 'already' }; // 끝난 계정은 스위치도 읽지 않는다(요청 0)
  const pause = await pauseState(c.client);
  if (!pause.paused) return { ran: false, reason: pause.error ? 'pauseUnknown' : 'notPaused' };
  if (!target) return { ran: false, reason: 'noCompany' };
  const r = await startArchive({ c, companies, run });
  if (r.promise) await r.promise;
  return { ran: !!r.started, ws: r.ws };
}

/** 설정 화면이 보는 상태 — 로컬 파일만 읽는다(요청 0). 스위치 값은 캐시(앱 시작·이 화면 첫 조회 때 읽은 값). */
export async function archiveStatus(uid, ws, { companies = defaultCompanies } = {}) {
  const target = await archiveTarget(uid, { companies });
  const st = target ? await readArchiveState(target.dir) : null;
  const running = !!RUN.promise && RUN.uid === uid;
  return {
    ws: target?.ws ?? null, here: !target || target.ws === ws, dir: target && st ? target.dir : null,
    status: running ? 'running' : st?.uid === uid ? (st.status === 'running' ? 'interrupted' : st.status) : 'none',
    totals: st?.totals ?? null, failed: st?.failed?.length ?? 0, finishedAt: st?.finishedAt ?? null, error: st?.error ?? null,
  };
}

export const _runState = RUN; // 시험용
