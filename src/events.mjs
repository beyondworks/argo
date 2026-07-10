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
