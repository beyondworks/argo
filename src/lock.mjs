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
  let heldTs = 0; // 내 것으로 확인된 마지막 기록의 ts — 남들은 이 값으로 만료를 판단한다
  let failing = false;
  const tick = async () => {
    try {
      try {
        const cur = JSON.parse(await readFile(file, 'utf8'));
        if (cur.owner !== OWNER && Date.now() - cur.ts < ttl) { mine = false; return; } // 살아있는 리더 존중
      } catch { /* lock 없음 — 선점 시도 */ }
      const ts = Date.now();
      await writeFile(file, JSON.stringify({ owner: OWNER, ts }));
      await new Promise((r) => setTimeout(r, 150)); // 동시 선점 레이스 — 최종 기록자만 리더
      mine = JSON.parse(await readFile(file, 'utf8')).owner === OWNER;
      if (mine) heldTs = ts;
      failing = false;
    } catch (e) {
      // 일시 I/O 오류(Windows EPERM·EBUSY 등)로 바로 내려놓으면, 파일의 내 기록이 아직 살아 있어 남도 안 가져가므로 다음 박자까지
      // 실행 주체가 0개가 된다(2026-10-02 Windows CI 재시작 경쟁 실패). 다음 박자 전에 내 기록이 만료되지 않는 동안만 유지한다.
      // 여유 박자 절반: 기준선이 ttl - beat 그대로면 두 번째 연속 실패 박자가 기준선에 정확히 걸려, 읽기 지연·타이머 흔들림 몇 ms로
      // 유지 쪽에 떨어지면 세 번째 박자(내 기록 만료 직후)에야 내려놓았다 — 그사이 다른 프로세스가 가져가면 이중 실행(2026-10-08 게이트 A).
      const was = mine;
      mine = mine && Date.now() - heldTs < ttl - beat - beat / 2;
      if (!failing || was !== mine) console.warn(`[argo] ${name} 리스 갱신 실패(${e?.code || e?.message}) — 리더 ${mine ? '유지' : '해제'}`);
      failing = true;
    }
  };
  const ready = tick(); // 첫 판정(쓰기 + 150ms 재확인) — daemonLeasesSettled가 기다린다
  const timer = setInterval(tick, beat);
  timer.unref?.();
  const handle = { isLeader: () => mine, ready };
  REG[name] = handle;
  return handle;
}
