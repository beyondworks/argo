// 이벤트 저널 — 활동 화면의 원천. usage.jsonl(과금·효율 지표)과 분리된 서사 계층이다.
// 원칙(리서치 근거): 예외·상태 변경이 1급, 각 이벤트는 산출물(rel)과 트리거 출처를 가진다.
// type: 'turn'(ok·source·gist·journalRel) | 'memory'(notes) | 'approval'(status) | 'crew'(op) | 'gateway'(op)
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

const file = (wsId) => join(paths(wsId).root, 'events.jsonl');

export async function appendEvent(wsId, event) {
  try {
    await appendFile(file(wsId), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch { /* 기록 실패가 본 흐름을 막으면 안 된다 */ }
}

/** 크루의 최근 완료 턴 n개(순수) — readEvents 결과(최신순)를 받아 최신 n개를 최신순 그대로.
    slice(-n).reverse()로 "가장 오래된 n개"를 집던 크루 카드 버그(검수 PR #211 K)의 재발 잠금 —
    라우트는 auth 계층(next/headers)에 묶여 Next 밖 단위 테스트가 못 여니 판정을 코어에 둔다.
    (export: 회귀 테스트용) */
export const recentTurnsOf = (events, slug, n = 8) =>
  (events ?? []).filter((e) => e?.slug === slug && e.type === 'turn' && e.gist).slice(0, n);

export async function readEvents(wsId, limit = 120) {
  try {
    const text = await readFile(file(wsId), 'utf8');
    return text.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit)
      .reverse();
  } catch {
    return [];
  }
}
