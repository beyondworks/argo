import { spawnSync } from 'node:child_process';

// pg 드릴의 psql 호출 한 곳. 두 가지를 맞춘다.
// 1) SHOW_ALL_RESULTS=off — psql 15+는 -c 안의 모든 문장 결과를 출력한다. 드릴은 `set role …; select set_config(…); <질의>`를
//    한 -c로 보내고 마지막 줄을 결과로 읽으므로, 15+에서는 set_config가 돌려준 uid 줄을 결과로 오독했다(PG17에서 36건 실패).
//    psql 14는 이 변수를 모르고 무시하므로 어느 쪽에서도 같은 출력이 된다.
// 2) 큰 -c 본문은 표준 입력으로 — 리눅스는 인자 하나가 128KB(MAX_ARG_STRLEN)를 넘으면 execve가 E2BIG로 실패한다
//    (20260903120000_msgr.sql이 153KB). -1 -f - 로 보내 "여러 문장을 한 트랜잭션으로"라는 -c의 의미를 유지한다.
//    ponytail: 크기로 가른다 — 결과를 읽는 짧은 질의는 -c 그대로(-f는 문장마다 결과를 찍어 같은 오독이 생긴다).
const STDIN_OVER = 64 * 1024;
export function psqlSpawn(db, args) {
  const i = args.indexOf('-c');
  const body = i >= 0 ? args[i + 1] ?? '' : '';
  const big = i >= 0 && Buffer.byteLength(body) > STDIN_OVER;
  const argv = big ? [...args.slice(0, i), '-1', '-f', '-', ...args.slice(i + 2)] : args;
  return spawnSync('psql', [db, '-X', '-v', 'ON_ERROR_STOP=1', '-v', 'SHOW_ALL_RESULTS=off', '-q', ...argv], { encoding: 'utf8', ...(big ? { input: body } : {}) });
}
