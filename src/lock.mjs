// 데몬 리더 선출 — Next가 라우트를 여러 워커(각자 globalThis)로 돌려도
// 스케줄러/게이트웨이 같은 상주 루프는 전체에서 딱 하나만 살아있어야 한다.
// 파일 lease: 하트비트로 갱신, 소유자가 죽으면(ttl 초과) 다른 워커가 계승한다.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';

const OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
// 이 프로세스가 켠 리스 등록부 — 동기화(sync.mjs)가 "이 프로세스가 실행 주인인가"를 묻는다(holdsDaemonLease). globalThis: Next 번들 사본이 갈려도 하나.
const REG = (globalThis.__argoDaemonLeases ??= {});

/** 이 프로세스가 이름 중 하나의 데몬 리스를 지금 쥐고 있는가. 켠 적 없는 이름은 거짓. */
export const holdsDaemonLease = (...names) => names.some((n) => REG[n]?.isLeader() === true);

/** 켠 리스들의 첫 판정이 끝날 때까지 기다린다(최대 timeoutMs). 첫 판정 전에는 isLeader가 늘 거짓이라, 기동 직후 첫 동기화 주기가
    이 프로세스를 실행 주인이 아니라고 보고 강등한 뒤 다음 주기(기본 8초)까지 리더가 비었다(#791 재검수 LOW-b). 켠 적 없는 이름은 바로 끝난다. */
export async function daemonLeasesSettled(names, timeoutMs = 2_000) {
  const pending = names.map((n) => REG[n]?.ready).filter(Boolean);
  if (!pending.length) return;
  let t; await Promise.race([Promise.all(pending), new Promise((r) => { t = setTimeout(r, timeoutMs); t.unref?.(); })]);
  clearTimeout(t);
}

export function daemonLease(name, { ttl = 15_000, beat = 5_000 } = {}) {
  const file = join(WS_ROOT, `.${name}.lock`);
  let mine = false;
  const tick = async () => {
    try {
      try {
        const cur = JSON.parse(await readFile(file, 'utf8'));
        if (cur.owner !== OWNER && Date.now() - cur.ts < ttl) { mine = false; return; } // 살아있는 리더 존중
      } catch { /* lock 없음 — 선점 시도 */ }
      await writeFile(file, JSON.stringify({ owner: OWNER, ts: Date.now() }));
      await new Promise((r) => setTimeout(r, 150)); // 동시 선점 레이스 — 최종 기록자만 리더
      mine = JSON.parse(await readFile(file, 'utf8')).owner === OWNER;
    } catch {
      mine = false;
    }
  };
  const ready = tick(); // 첫 판정(쓰기 + 150ms 재확인) — daemonLeasesSettled가 기다린다
  const timer = setInterval(tick, beat);
  timer.unref?.();
  const handle = { isLeader: () => mine, ready };
  REG[name] = handle;
  return handle;
}
