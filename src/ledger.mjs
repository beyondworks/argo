// 추가형 원장(events·usage) 파일 위치 — 쓰기 조각과 합쳐 읽기의 단일 관문.
// 옛 형식은 회사 폴더 직속 `events.jsonl`·`usage.jsonl` 한 파일이다. 동기화는 원장을 파일 단위로 올리고 받으므로(sync.mjs isLedger·mergeLedger)
// 한 줄을 덧붙일 때마다 몇십 MB 파일 전체가 오갔다(M1 운영 조사 2026-10-23: 한 회사가 events 1.4GB/일).
// ARGO_LEDGER_SPLIT=1이면 새 줄을 `<종류>.<기기>.<YYYY-MM>.jsonl`(UTC 월)에 쓴다 — 이번 달 이 기기 조각만 바뀌므로 오가는 것은 그 조각뿐이다.
// 읽기는 플래그와 상관없이 옛 파일 + 모든 조각을 합친다(옛 앱은 계속 옛 파일에 쓰고, 플래그를 껐다 켜도 조각이 남는다). 옛 파일은 지우지 않는다.
// 기본 꺼짐: 옛 앱은 조각을 읽지 못해 월 예산 상한이 다른 기기 지출을 못 본다 — 최소 앱 버전 게이트를 올린 뒤에 켠다(총괄 결정 2026-10-23).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { paths, getDeviceId } from './workspace.mjs';

export const LEDGER_KINDS = ['events', 'usage'];
export const ledgerSplitOn = () => process.env.ARGO_LEDGER_SPLIT === '1';
/** 조각 이름(export: 권한 게이트·회귀 테스트용) — 기기 조각은 소문자·숫자·`-`만, 월은 UTC `YYYY-MM`. */
export const LEDGER_PIECE_RE = /^(events|usage)\.([a-z0-9-]{1,64})\.(\d{4}-\d{2})\.jsonl$/;

/** 기기 id → 파일 이름 조각(순수). hostname 앞부분이라 대문자·밑줄·한글이 올 수 있다. */
export const deviceSlug = (id) => String(id ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'device';

/** 이 줄을 덧붙일 파일 — 꺼짐이면 옛 파일. ts는 줄의 ts(ISO, UTC)라 기기 시간대와 무관하게 같은 월 조각이 된다. */
export async function ledgerAppendPath(wsId, kind, ts = new Date().toISOString()) {
  const root = paths(wsId).root;
  if (!ledgerSplitOn()) return join(root, `${kind}.jsonl`);
  const id = await getDeviceId().catch(() => null);
  if (!id) return join(root, `${kind}.jsonl`); // 기기 id를 못 읽으면 옛 파일에 — 줄을 잃지 않는다(읽기는 둘 다 합친다)
  const month = String(ts).slice(0, 7);
  return join(root, `${kind}.${deviceSlug(id)}.${/^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7)}.jsonl`);
}

const parseLines = (text) => text.split('\n').filter(Boolean);

/** 한 종류의 원장 줄 전부(오래된 것 → 새 것). 조각이 없으면 옛 파일의 파일 순서 그대로(배포본과 같다 — 동기화 병합본은 ts 순서가 아닐 수 있다).
    조각이 있으면 옛 파일 + 조각을 합쳐 같은 줄을 한 번만 두고 ts로 정렬한다(ts가 같거나 없으면 읽은 순서 유지). 파일 하나를 못 읽어도 나머지는 읽는다. */
export async function readLedgerLines(wsId, kind) {
  const root = paths(wsId).root;
  const pieces = await readdir(root).then((names) => names.filter((n) => LEDGER_PIECE_RE.exec(n)?.[1] === kind).sort(), () => []); // 플래그와 무관(머리말)
  const legacy = await readFile(join(root, `${kind}.jsonl`), 'utf8').then(parseLines, () => []);
  if (!pieces.length) return legacy;
  const seen = new Set();
  const all = [];
  for (const lines of [legacy, ...await Promise.all(pieces.map((n) => readFile(join(root, n), 'utf8').then(parseLines, () => [])))]) {
    for (const l of lines) if (!seen.has(l)) { seen.add(l); all.push(l); }
  }
  const tsOf = (l) => { try { const ts = JSON.parse(l)?.ts; return typeof ts === 'string' ? ts : ''; } catch { return ''; } };
  return all.map((l, i) => [tsOf(l), i, l]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])).map((x) => x[2]);
}
