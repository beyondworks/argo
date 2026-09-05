// 원격 모델 카탈로그 오버레이 — 벤더가 모델을 추가·폐기·개명해도 **앱 발행 없이** 따라간다.
//
// 왜(2026-09-05): Argo의 RUNNERS 모델 목록은 catalog.mjs 하드코딩이라 벤더 변경 하나에 범프→CI→공증→
// 발행(1.5시간·유건만 가능)이 통째로 필요했다. Hermes는 hermes_cli/model_catalog.py가 원격 매니페스트
// (20분 TTL·디스크 캐시·실패 시 stale 유지)를 받고, OpenClaw는 매니페스트의 modelIdNormalization으로
// 별칭·폐기 id를 현행 id로 정규화한다(extensions/anthropic/claude-model-refs.ts). 둘을 합쳐 이식했다.
//
// 계약(스키마 1): { schema:1, runners: { <runnerId>: { add?:[{id,label,gated?}], retire?:[id], alias?:{old:new} } } }
//  · add    — 카탈로그에 없는 모델을 끝에 붙인다(같은 id가 이미 있으면 무시 — 코드가 정본)
//  · retire — 그 id를 목록에서 뺀다(지정돼 있던 크루는 chat.mjs가 modelFallback으로 고지)
//  · alias  — 사용자가 고른/카드에 적힌 옛 id를 현행 id로 바꾼다(normalizeModelId — 저장·실행 양쪽)
// 실패는 절대 던지지 않는다: 원격 불가면 디스크 캐시, 그것도 없으면 오버레이 없음(코드 목록 그대로).
// 원격은 우리가 이미 통제하는 채널(argo-agent 릴리스 자산)이다 — 타사 URL을 믿지 않는다.
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUNNERS } from './catalog.mjs';
import { writeJsonAtomic } from '../jsonstore.mjs';

export const SCHEMA = 1;
export const CATALOG_TTL_MS = 20 * 60_000; // Hermes DEFAULT_TTL_MINUTES = 20과 같은 값
export const REMOTE_CATALOG_URL = 'https://github.com/beyondworks/argo-agent/releases/latest/download/model-catalog.json';
export const cacheFile = () => join(process.env.ARGO_CACHE_DIR || join(homedir(), '.argo', 'cache'), 'model-catalog.json');

let mem = { at: 0, overlay: null }; // 프로세스 내 캐시 — TTL 안에서는 디스크·네트워크를 안 본다
export function _resetForTest() { mem = { at: 0, overlay: null }; }
export const currentOverlay = () => mem.overlay;

const isId = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
/** 스키마 검증(순수) — 모양이 틀리면 null(부분 수용 없음: 잘못된 오버레이가 목록을 반쯤 바꾸는 것이 더 위험). */
export function validateOverlay(o) {
  if (!o || typeof o !== 'object' || o.schema !== SCHEMA || !o.runners || typeof o.runners !== 'object') return null;
  const runners = {};
  for (const [rid, spec] of Object.entries(o.runners)) {
    if (!RUNNERS[rid] || !spec || typeof spec !== 'object') return null;
    const add = Array.isArray(spec.add) ? spec.add : [];
    const retire = Array.isArray(spec.retire) ? spec.retire : [];
    const alias = spec.alias && typeof spec.alias === 'object' ? spec.alias : {};
    if (!add.every((m) => m && isId(m.id) && (m.label === undefined || typeof m.label === 'string'))) return null;
    if (!retire.every(isId)) return null;
    if (!Object.entries(alias).every(([a, b]) => isId(a) && isId(b))) return null;
    runners[rid] = {
      add: add.map((m) => ({ id: m.id.trim(), label: typeof m.label === 'string' && m.label.trim() ? m.label.trim() : m.id.trim(), ...(m.gated ? { gated: true } : {}) })),
      retire: retire.map((s) => s.trim()),
      alias: Object.fromEntries(Object.entries(alias).map(([a, b]) => [a.trim(), b.trim()])),
    };
  }
  return { schema: SCHEMA, runners };
}

/** 코드 목록 + 오버레이 → 유효 목록(순수). 기본 모델('')은 항상 보존. retire가 add보다 먼저(둘 다 있으면 add가 이긴다 = 되살림 의도). */
export function applyOverlay(runnerId, models, overlay) {
  const spec = overlay?.runners?.[runnerId];
  if (!spec) return models;
  const retired = new Set(spec.retire ?? []);
  const out = (models ?? []).filter((m) => m.id === '' || !retired.has(m.id));
  const have = new Set(out.map((m) => m.id));
  for (const m of spec.add ?? []) if (!have.has(m.id)) { out.push(m); have.add(m.id); }
  return out;
}
export const effectiveModels = (runnerId, overlay = mem.overlay) => applyOverlay(runnerId, RUNNERS[runnerId]?.models ?? [], overlay);
/** 옛 id → 현행 id(순수). 매핑이 없으면 그대로. 체인은 1단만(a→b→c는 명시적으로 a→c로 쓰게 — 순환 방지). */
export function normalizeModelId(runnerId, id, overlay = mem.overlay) {
  const s = typeof id === 'string' ? id.trim() : '';
  if (!s) return s;
  return overlay?.runners?.[runnerId]?.alias?.[s] ?? s;
}
/** 이 id가 그 러너에서 유효한가(순수) — ''(기본)은 항상 유효. alias 적용 후 판정. */
export function isKnownModel(runnerId, id, overlay = mem.overlay) {
  const n = normalizeModelId(runnerId, id, overlay);
  return n === '' || effectiveModels(runnerId, overlay).some((m) => m.id === n);
}

async function readCache() {
  try { return validateOverlay(JSON.parse(await readFile(cacheFile(), 'utf8'))); } catch { return null; }
}

/** 오버레이 로드 — 메모리(TTL) → 디스크 → 원격. 원격 성공 시 디스크 갱신. 어떤 실패도 던지지 않는다.
    주입(fetchImpl·now·ttlMs·url)은 테스트 전용. 반환은 오버레이 또는 null(코드 목록 그대로 쓰라는 뜻). */
export async function loadRemoteCatalog({ fetchImpl = globalThis.fetch, now = Date.now(), ttlMs = CATALOG_TTL_MS, url = process.env.ARGO_MODEL_CATALOG_URL || REMOTE_CATALOG_URL, timeoutMs = 8000 } = {}) {
  if (mem.overlay !== null && now - mem.at < ttlMs) return mem.overlay;
  if (mem.overlay === null && mem.at === 0) { // 첫 호출 — 디스크 캐시로 즉시 채운다(원격은 아래서 시도)
    const disk = await readCache();
    if (disk) mem = { at: 0, overlay: disk };
  }
  // 'off' = 네트워크 차단 스위치(테스트·오프라인 운영). 주입 fetchImpl은 테스트 의도이므로 통과시킨다.
  if (process.env.ARGO_MODEL_CATALOG === 'off' && fetchImpl === globalThis.fetch) { mem.at = now; return mem.overlay; }
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`http ${r.status}`);
    const fresh = validateOverlay(await r.json());
    if (!fresh) throw new Error('invalid overlay schema');
    mem = { at: now, overlay: fresh };
    try { await mkdir(join(cacheFile(), '..'), { recursive: true }); await writeJsonAtomic(cacheFile(), fresh); } catch { /* 캐시 실패는 무해 */ }
    return fresh;
  } catch (e) {
    // stale 유지(Hermes 규칙) — 시각만 갱신해 TTL 동안 재시도 폭주를 막는다. 로그는 1회성 경고 없이 디버그.
    mem.at = now;
    return mem.overlay;
  }
}
