// 게이트웨이 영속 — 폴러 offset·슬랙 커서·하트비트. 순수 파일 I/O만 있어
// 네트워크·타이머 없이 임시 ARGO_ROOT로 단위 테스트 가능한 이음매(gateway.mjs 분해).
// 옮긴 코드는 gateway.mjs 원문 그대로(행동 불변) — 주석 동반 이동.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../workspace.mjs';
import { writeJsonAtomic, readJsonLenient } from '../jsonstore.mjs';

/** 폴러 하트비트 — 연결 카드의 "가동 중 · N초 전 응답" 표시의 원천. root의 dotfile이라 vault 스캔 무관. */
export async function beatGateway(wsId, kind, ok, error = '') {
  try {
    await writeFile(join(paths(wsId).root, `.gateway-${kind}.json`), JSON.stringify({ ts: Date.now(), ok, error: String(error).slice(0, 200) }));
  } catch { /* 하트비트는 베스트에포트 */ }
}

// 폴러 offset 영속화 — 재시작·리더 교체 시 offset=0으로 되돌아가 마지막 배치를 재수신·재실행하는 것을 막는다.
// offset은 lenient 로드(손상 시 0부터 재개 — 재수신은 디스크 큐가 멱등 재적재로 방어).
export async function loadOffset(wsId, key) {
  const o = await readJsonLenient(join(paths(wsId).root, `.gw-offset-${key}.json`), { offset: 0 });
  return o?.offset ?? 0;
}
export async function saveOffset(wsId, key, offset) {
  try { await writeJsonAtomic(join(paths(wsId).root, `.gw-offset-${key}.json`), { offset }); }
  catch { /* 베스트에포트 */ }
}

// 슬랙 커서 영속 — 텔레그램과 달리 서버측 수신 확정(offset)이 없어 이 파일이 유일한 재개 지점이다.
// 재시작 시 다운타임에 온 지시·결재 회신을 이어받는다(이전엔 인메모리 '지금'부터라 통째 유실).
// 비점(non-dot) 파일이라 동기화를 타고 기기 간 LWW로 수렴 — 리더가 바뀐 기기도 마지막 지점부터 잇는다
// (전환 직전 ~8s 미동기 창은 재수신·중복 쪽으로 흡수 — at-least-once, 유실 없음).
export const slackCursorFile = (wsId) => join(paths(wsId).root, 'gw-cursor-slack.json');
export async function loadSlackCursor(wsId) { return (await readJsonLenient(slackCursorFile(wsId), null))?.ts ?? null; }
export async function saveSlackCursor(wsId, ts) {
  try { await writeJsonAtomic(slackCursorFile(wsId), { ts }); }
  catch { /* 베스트에포트 — 다음 배치가 다시 저장한다 */ }
}
