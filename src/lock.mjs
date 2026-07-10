// 데몬 리더 선출 — Next가 라우트를 여러 워커(각자 globalThis)로 돌려도
// 스케줄러/게이트웨이 같은 상주 루프는 전체에서 딱 하나만 살아있어야 한다.
// 파일 lease: 하트비트로 갱신, 소유자가 죽으면(ttl 초과) 다른 워커가 계승한다.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WS_ROOT } from './workspace.mjs';

const OWNER = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

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
  tick();
  const timer = setInterval(tick, beat);
  timer.unref?.();
  return { isLeader: () => mine };
}
