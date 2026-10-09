// 턴 작업 과정 기록(trace) — 답이 나오기 전까지 "생각·도구·실행 중인 작업"이 차례로 쌓여 보이고(Claude Code·Codex처럼),
// 끝난 뒤에도 답 아래 접힌 '작업 과정'으로 다시 볼 수 있게 한다(유건 요청 2026-10-09).
//
// 계약(설계 메모 요약 — 바꾸면 화면·저장·폴링이 같이 바뀐다):
//  · 턴 하나 = trace 하나. 논리 턴 제어 객체(turn-abort withTurnControl의 control)에 붙어 재시도 프레임은 같은 trace에 이어 쌓이고,
//    같은 크루의 다른 턴(루틴·회의실·메신저)·위임받은 동료 턴은 다른 trace다 — 크루당 하나인 상태 파일이 섞이던 문제를 여기서 끊는다.
//  · 진행 중에는 메모리(globalThis 등록부)에만 있다 — 디스크 쓰기 0. 끝나면 저장 대상 출처(1:1 'chat'·회의실 'room')만
//    <ws>/.turn-traces/<slug>/<id>.json 한 번 + index.json 한 줄. 이 기기에만 둔다(sync EXCLUDE·diff 불가시).
//  · 턴당 200KB 상한, 에이전트별 최근 100턴 그리고 30일 보존(저장할 때마다 정리).
//  · 입력·결과·생각은 기록기에 넣을 때 가린다(maskSecrets) — 저장본·폴링·화면은 가린 값만 본다.
//  · 폴링은 수정 번호(v)가 커진 단계의 보기(input 300자·결과 앞 20줄)만, 합계 32KB 상한. 전체는 펼칠 때 따로 받는다.
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { paths } from './workspace.mjs';
import { sanitizeFileSlug } from './slug.mjs';
import { writeJsonAtomic, readJsonLenient } from './jsonstore.mjs';
import { withLock } from './mutex.mjs';
import { maskKeyLike } from './runners/shared.mjs';
import { stageForTool, detailForTool } from './turn-status.mjs';

export const TRACE_DIR = '.turn-traces'; // 회사 루트 직속 도트 — 권한 게이트 WS_DOT_FILES·sync EXCLUDE가 같은 이름을 본다
export const TRACE_CAP_BYTES = 204_800; // 턴당 저장 상한 200KB(유건 확정)
export const TRACE_KEEP_TURNS = 100; // 에이전트별 최근 100턴
export const TRACE_KEEP_DAYS = 30; // 그리고 30일
export const PREVIEW_LINES = 20; // 결과 앞 20줄 + 'N줄 더 보기'(유건 확정)
export const POLL_BUDGET_BYTES = 32_768; // 진행 폴 한 번에 싣는 단계 보기 합계 상한
export const MAX_STEPS = 1000; // 턴당 단계 수 상한(넘으면 수만 센다)
export const PERSIST_SOURCES = new Set(['chat', 'room']); // 끝난 뒤 보존하는 출처 — 1:1 대화·회의실(유건 범위)
const INPUT_STORE = 8000; // 단계 입력 저장 상한(Write 본문 같은 큰 인자만 잘린다 — 명령·경로·인자는 이 안에 다 들어온다)
const RESULT_STORE = 16_000; // 단계 결과 저장 상한(글자)
const RESULT_STORE_LINES = 400;
const THINK_STORE = 4000;
const MEM_BUDGET = 400_000; // 턴당 메모리 보관 글자 예산 — 넘으면 이후 결과는 앞 20줄만(병렬 회의 8명 × 긴 턴의 메모리 방어)
const VIEW_INPUT = 300;
const VIEW_RESULT_CHARS = 1500;

/* ─── 가림 ─── */
// 이름이 비밀을 뜻하는 KEY=VALUE·KEY: VALUE(따옴표 JSON 키 포함)는 값만 가린다(무엇이 있었는지는 보이게). 이름 판정을 좁게 둔다 —
// 'key'가 들어간 아무 이름(monkey·keyboard·primaryKey)까지 가리면 평범한 도구 출력이 읽히지 않는다.
const SECRET_TAIL = /(?:^|[_.-])(?:api[_-]?key|apikey|secret|secret[_-]?key|secretkey|token|access[_-]?token|accesstoken|refresh[_-]?token|refreshtoken|id[_-]?token|auth[_-]?token|authtoken|bot[_-]?token|password|passwd|pwd|credentials?|authorization|auth|database[_-]?url|databaseurl|dsn|private[_-]?key|privatekey|access[_-]?key(?:[_-]?id)?|accesskey(?:id)?|cookie|session[_-]?token|sessiontoken|client[_-]?secret|clientsecret|webhook[_-]?secret|signing[_-]?secret)$/i;
/** 이름이 비밀 자리인가(순수) — OPENAI_API_KEY·GITHUB_TOKEN·client_secret·apiKey·password·DATABASE_URL·SUPABASE_SERVICE_ROLE_KEY(대문자 *_KEY). */
export const isSecretName = (name) => {
  const n = String(name ?? '');
  return SECRET_TAIL.test(n) || /(?:^|_)[A-Z0-9_]*KEY$/.test(n) || /^[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN)[A-Z0-9_]*$/.test(n);
};
const KV_RE = /(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,80})\1(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&}\]]+)/g;
const masked = (v) => /^(["'])?(?:\*+|sk-\*\*\*)\1?$/.test(v);
/** 화면·저장에 실리는 단계 글에서 비밀 모양을 가린다(순수). maskKeyLike(벤더 키 모양) 위에 PEM 개인키·Bearer·URL 비밀번호·이름이 비밀인 KEY=VALUE. */
export function maskSecrets(s) {
  if (s == null) return '';
  let out = String(s);
  out = out.replace(/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g, '-----BEGIN $1PRIVATE KEY----- *** -----END $1PRIVATE KEY-----');
  out = maskKeyLike(out);
  out = out.replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***');
  out = out.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi, '$1$2:***@');
  out = out.replace(KV_RE, (m, q, name, sep, val) => {
    if (!isSecretName(name) || masked(val) || /^(Bearer|Basic|Token)$/.test(val)) return m;
    return `${q}${name}${q}${sep}${val.startsWith('"') ? '"***"' : val.startsWith("'") ? "'***'" : '***'}`;
  });
  return out;
}

/* ─── 글 다듬기 ─── */
const lineCount = (s) => (s ? String(s).split('\n').length : 0);
/** 앞 n줄 미리보기(순수) — { text, lines(원래 줄 수), more(남은 줄 수) }. 300줄 → 20줄 + more 280. */
export function previewLines(text, n = PREVIEW_LINES, maxChars = Infinity) {
  const s = String(text ?? '');
  if (!s) return { text: '', lines: 0, more: 0 };
  const all = s.split('\n');
  let head = all.slice(0, n).join('\n');
  if (head.length > maxChars) head = `${head.slice(0, maxChars)}…`;
  return { text: head, lines: all.length, more: Math.max(0, all.length - n) };
}
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}…` : s);
function clipLines(s, maxLines, maxChars) {
  const all = s.split('\n');
  let out = all.length > maxLines ? all.slice(0, maxLines).join('\n') : s;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  return { text: out, cut: out.length < s.length };
}

/** 도구 입력 → 표시 글(순수). 셸 명령은 명령 그대로, 나머지는 '키: 값' 줄 — 명령·경로·인자를 전부 보인다. */
export function inputText(name, input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return String(input);
  const cmd = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : null;
  if (cmd != null && /^(Bash|shell|exec)$/i.test(name)) {
    const rest = Object.entries(input).filter(([k]) => k !== 'command' && k !== 'description');
    return [`$ ${cmd}`, ...rest.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)].join('\n');
  }
  return Object.entries(input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
}

/** 도구 결과(문자열 또는 블록 배열) → 글(순수). 이미지는 자리표시만. */
export function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b == null) return '';
      if (typeof b === 'string') return b;
      if (b.type === 'text') return String(b.text ?? '');
      if (b.type === 'image') return '[image]';
      if (b.type === 'resource' && b.resource?.text) return String(b.resource.text);
      return JSON.stringify(b);
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && Array.isArray(content.content)) return resultText(content.content);
  return JSON.stringify(content);
}

const TASK_TOOLS = /^(Task|Agent|TodoWrite)$/;
const kindOf = (name) => (TASK_TOOLS.test(name) ? 'task' : 'tool');

/* ─── 등록부(진행 중 trace) ─── */
const LIVE = (globalThis.__argoLiveTraces ??= new Map()); // 'ws:slug' → Map(id → 기록기) — 라우트 번들 사본끼리 공유(turn-abort와 같은 방식)
const liveKey = (wsId, slug) => `${wsId}:${slug}`;
const newId = (now) => `tr${now.toString(36)}${randomBytes(4).toString('hex')}`;
export const TRACE_ID_RE = /^tr[a-z0-9]{6,12}[0-9a-f]{8}$/;

/** 턴 기록기를 만든다. persist=false면 끝나도 파일을 쓰지 않는다(진행 중 보기만). */
export function createTrace({ wsId, slug, source = 'chat', persist = PERSIST_SOURCES.has(source), now = Date.now } = {}) {
  const startedAt = now();
  const id = newId(startedAt);
  const steps = [];
  const byTool = new Map(); // 도구 id → 단계
  let rev = 0; let dropped = 0; let memUsed = 0; let ended = null; let model = null; let finished = null;
  const at = () => now() - startedAt;
  const charge = (s) => { memUsed += s.length; };
  const overBudget = () => memUsed > MEM_BUDGET;
  const push = (st) => {
    if (steps.length >= MAX_STEPS) { dropped += 1; return null; }
    st.i = steps.length + dropped; st.v = ++rev;
    steps.push(st);
    return st;
  };
  const touch = (st) => { st.v = ++rev; };
  const storeResult = (st, raw, isError) => {
    const masked = maskSecrets(raw).replace(/\s+$/, ''); // 끝 줄바꿈은 줄 수에 넣지 않는다(seq 300 → 300줄, 301줄 아님)
    st.lines = lineCount(masked);
    const lim = overBudget() ? { lines: PREVIEW_LINES, chars: VIEW_RESULT_CHARS } : { lines: RESULT_STORE_LINES, chars: RESULT_STORE };
    const c = clipLines(masked, lim.lines, lim.chars);
    st.result = c.text; st.cut = c.cut;
    charge(st.result);
    st.status = isError ? 'err' : 'ok';
  };

  const rec = {
    id, wsId, slug, source, startedAt, persist,
    /** 생각 한 덩어리(모델이 준 사고 요약). 빈 글은 무시. */
    think(text, { parent = null } = {}) {
      const s = String(text ?? '').trim();
      if (!s || ended) return null;
      const body = clip(maskSecrets(s), THINK_STORE); charge(body);
      return push({ id: null, kind: 'think', name: '', input: '', result: body, lines: lineCount(body), cut: body.length < s.length, status: 'ok', t: at(), ms: 0, parent });
    },
    /** 도구(또는 하위 작업) 시작. 같은 id가 다시 오면 입력만 갱신한다(codex item.started → item.completed). */
    toolStart({ id: toolId = null, name, input, parent = null, kind = null } = {}) {
      if (ended) return null;
      const nm = String(name ?? 'tool');
      if (toolId && byTool.has(toolId)) { const st = byTool.get(toolId); if (input !== undefined) { st.input = clip(maskSecrets(inputText(nm, input)), INPUT_STORE); touch(st); } return st; }
      const body = clip(maskSecrets(inputText(nm, input)), INPUT_STORE); charge(body);
      const st = push({ id: toolId, kind: kind ?? kindOf(nm), name: nm, input: body, result: '', lines: 0, cut: false, status: 'run', t: at(), ms: 0, parent, _raw: input });
      if (st && toolId) byTool.set(toolId, st);
      return st;
    },
    /** 도구 끝 — 결과·오류를 짝지은 단계에 싣는다. 짝이 없으면(시작을 못 본 결과) 새 단계로. */
    toolEnd(toolId, { result = '', isError = false, name = 'tool', input, ms = null } = {}) {
      if (ended) return null;
      let st = toolId ? byTool.get(toolId) : null;
      if (!st) st = rec.toolStart({ id: toolId, name, input });
      if (!st) return null;
      storeResult(st, resultText(result), isError);
      st.ms = Number.isFinite(ms) ? ms : Math.max(0, at() - st.t);
      touch(st);
      return st;
    },
    /** 텍스트 모드 러너처럼 단계가 하나뿐인 실행 — 시작을 남기고 끝낼 함수를 돌려준다. */
    task(name) {
      const st = rec.toolStart({ name, kind: 'task' });
      return (ok = true) => { if (st && st.status === 'run') { st.status = ok ? 'ok' : 'err'; st.ms = Math.max(0, at() - st.t); touch(st); } };
    },
    setModel(m) { if (m) model = String(m); },
    get rev() { return rev; },
    get size() { return steps.length + dropped; },
    get ended() { return ended; },
    /** 끝나면 이 기기에 남는 기록인가(저장 대상 출처 + 단계 1개 이상) — chat()이 traceId를 결과·오류에 실을지 정한다. */
    get kept() { return !!(persist && wsId && slug && steps.length); },
    /** 옛 소비자(상태 파일·활동 이벤트)용 짧은 궤적 — 마지막 n개 도구 단계 { t, stage, detail }. 40개에서 멈추던 step()을 대신한다. */
    compact(n = 40) {
      const tools = steps.filter((s) => s.kind !== 'think');
      return tools.slice(-n).map((s) => ({ t: s.t, stage: stageForTool(s.name), detail: detailForTool(s.name, s._raw ?? {}) }));
    },
    get toolCount() { return steps.filter((s) => s.kind !== 'think').length + dropped; },
    /** 폴링 보기 — v > since인 단계만, 보기 합계 budget 바이트까지. rev는 실은 마지막 단계의 v(못 실은 것은 다음 폴). */
    view(since = 0, budget = POLL_BUDGET_BYTES) {
      const fresh = steps.filter((s) => s.v > since).sort((a, b) => a.v - b.v);
      const out = []; let used = 0; let last = since; let more = false;
      for (const s of fresh) {
        const v = stepView(s);
        const sz = Buffer.byteLength(JSON.stringify(v));
        if (out.length && used + sz > budget) { more = true; break; }
        out.push(v); used += sz; last = s.v;
      }
      return { id, source, startedAt, rev: last, n: steps.length + dropped, dropped, steps: out, more, ended: !!ended };
    },
    /** 최근 n단계 보기(회의실 발언 카드 한눈 보기). */
    tail(n = 6) { return steps.slice(-n).map(stepView); },
    /** 저장 모양(가린 값만 — _raw 제외). */
    data() {
      return {
        v: 1, id, slug, source, startedAt, endedAt: ended?.at ?? null, ms: ended ? ended.at - startedAt : at(), ok: ended ? ended.ok : null,
        aborted: !!ended?.aborted, model, rev, n: steps.length + dropped, dropped, capped: false,
        steps: steps.map(({ _raw, v, ...s }) => s),
      };
    },
    /** 끝 — 돌던 단계를 닫고(중단이면 stop), 저장 대상이면 파일·index를 쓰고 보존 정리. 두 번 불러도 한 번만. */
    finish({ ok = true, aborted = false } = {}) {
      if (finished) return finished;
      ended = { at: now(), ok: !!ok && !aborted, aborted: !!aborted };
      for (const s of steps) if (s.status === 'run') { s.status = aborted ? 'stop' : ok ? 'ok' : 'err'; s.ms = Math.max(0, ended.at - startedAt - s.t); s.v = ++rev; }
      const m = LIVE.get(liveKey(wsId, slug)); m?.delete(id); if (m && !m.size) LIVE.delete(liveKey(wsId, slug));
      // 단계가 하나도 없는 턴(모델 호출 전 실패 등)은 남기지 않는다 — '0단계' 기록은 볼 것이 없고 디스크만 쓴다
      finished = persist && wsId && slug && steps.length ? saveTrace(wsId, slug, rec.data()).catch((e) => { console.warn(`[argo] 작업 과정 저장 실패(${wsId}/${slug}): ${String(e?.message ?? e).slice(0, 160)}`); return null; }) : Promise.resolve(null);
      return finished;
    },
  };
  if (wsId && slug) {
    const k = liveKey(wsId, slug);
    if (!LIVE.has(k)) LIVE.set(k, new Map());
    LIVE.get(k).set(id, rec);
  }
  return rec;
}

/** 단계 → 폴링 보기(순수). 입력 앞 300자·결과 앞 20줄(1,500자). */
export function stepView(s) {
  const p = previewLines(s.result, PREVIEW_LINES, VIEW_RESULT_CHARS);
  return {
    i: s.i, id: s.id ?? null, kind: s.kind, name: s.name, status: s.status, t: s.t, ms: s.ms, parent: s.parent ?? null,
    input: clip(s.input ?? '', VIEW_INPUT), inputLen: (s.input ?? '').length,
    result: p.text, lines: s.lines || p.lines, cut: !!s.cut,
  };
}

/** 같은 크루의 진행 중 trace 목록(최신 시작 먼저). */
export function liveTraces(wsId, slug) {
  return [...(LIVE.get(liveKey(wsId, slug))?.values() ?? [])].sort((a, b) => b.startedAt - a.startedAt);
}
/** 화면이 볼 trace 고르기 — 보고 있던 id(want)가 살아 있으면 그대로(두 턴이 번갈아 상태 파일을 써도 화면이 튀지 않게), 아니면 상태 파일이 가리키는 것(pointer), 그다음 최신. */
export function pickLiveTrace(wsId, slug, { want = null, pointer = null } = {}) {
  const m = LIVE.get(liveKey(wsId, slug));
  if (!m?.size) return null;
  if (want && m.has(want)) return m.get(want);
  if (pointer && m.has(pointer)) return m.get(pointer);
  return liveTraces(wsId, slug)[0] ?? null;
}

/* ─── 디스크(끝난 trace) ─── */
const dirOf = (wsId, slug) => join(paths(wsId).root, TRACE_DIR, sanitizeFileSlug(slug));
const fileOf = (wsId, slug, id) => join(dirOf(wsId, slug), `${id}.json`);
const indexOf = (wsId, slug) => join(dirOf(wsId, slug), 'index.json');

/** 200KB 상한으로 줄이기(순수) — 오래된 결과부터 앞 20줄 → 입력 500자 → 생각 500자 → 본문 비우기 → 가운데 단계 제거. */
export function shrinkTrace(data, cap = TRACE_CAP_BYTES) {
  const size = (d) => Buffer.byteLength(JSON.stringify(d));
  if (size(data) <= cap) return data;
  const d = { ...data, steps: data.steps.map((s) => ({ ...s })), capped: true };
  const passes = [
    (s) => { if (s.kind !== 'think' && s.result && lineCount(s.result) > PREVIEW_LINES) { s.result = previewLines(s.result, PREVIEW_LINES, VIEW_RESULT_CHARS).text; s.cut = true; } },
    (s) => { if (s.input?.length > 500) s.input = `${s.input.slice(0, 500)}…`; },
    (s) => { if (s.kind === 'think' && s.result?.length > 500) { s.result = `${s.result.slice(0, 500)}…`; s.cut = true; } },
    (s) => { if (s.input || s.result) { s.input = ''; s.result = ''; s.cut = true; } },
  ];
  for (const pass of passes) {
    for (const s of d.steps) { pass(s); if (size(d) <= cap) return d; }
  }
  // 그래도 넘으면(단계 제목만으로 상한을 넘는 극단) 가운데부터 뺀다 — 처음과 끝이 가장 쓸모 있다.
  while (d.steps.length > 2 && size(d) > cap) { d.steps.splice(Math.floor(d.steps.length / 2), 1); d.dropped = (d.dropped ?? 0) + 1; }
  return d;
}

/** 끝난 trace 저장 + index 한 줄 + 보존 정리. 같은 크루의 index 갱신은 프로세스 안에서 한 줄로 세운다. */
export async function saveTrace(wsId, slug, data, { now = Date.now } = {}) {
  if (!TRACE_ID_RE.test(String(data?.id ?? ''))) throw new Error('bad trace id');
  const body = shrinkTrace(data);
  await writeJsonAtomic(fileOf(wsId, slug, data.id), body);
  await withLock(`trace-index:${wsId}:${sanitizeFileSlug(slug)}`, async () => {
    const idx = await readJsonLenient(indexOf(wsId, slug), null);
    const items = idx && typeof idx.items === 'object' && idx.items ? idx.items : {};
    items[data.id] = { n: body.n, ms: body.ms, ok: body.ok, at: body.endedAt ?? now(), source: body.source };
    const kept = await pruneTraces(wsId, slug, items, { now });
    await writeJsonAtomic(indexOf(wsId, slug), { v: 1, items: kept });
  });
  return body;
}

/** 보존 정리 — 최근 100턴 그리고 30일. 파일 목록 기준(index에 없는 고아 파일도 같은 규칙). 반환: 남긴 index 항목. */
async function pruneTraces(wsId, slug, items, { now = Date.now } = {}) {
  const dir = dirOf(wsId, slug);
  // 지우는 대상은 이 모듈이 만든 이름(trace id)만 — 폴더에 다른 파일이 있어도 건드리지 않는다
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && TRACE_ID_RE.test(n.slice(0, -5)));
  const rows = await Promise.all(names.map(async (n) => {
    const id = n.slice(0, -5);
    const at = items[id]?.at ?? (await stat(join(dir, n)).then((s) => s.mtimeMs, () => 0));
    return { id, n, at };
  }));
  rows.sort((a, b) => b.at - a.at);
  const cutoff = now() - TRACE_KEEP_DAYS * 86_400_000;
  const keep = new Set(); const drop = [];
  for (const [i, r] of rows.entries()) {
    if (i < TRACE_KEEP_TURNS && r.at >= cutoff) keep.add(r.id); else drop.push(r);
  }
  await Promise.all(drop.map((r) => rm(join(dir, r.n), { force: true }).catch(() => {})));
  return Object.fromEntries(Object.entries(items).filter(([id]) => keep.has(id)));
}

/** 끝난 trace 읽기(이 기기 파일). 없으면 null. */
export async function readTrace(wsId, slug, id) {
  if (!TRACE_ID_RE.test(String(id ?? ''))) return null;
  return readJsonLenient(fileOf(wsId, slug, id), null);
}

/** 이 기기의 trace 요약 — ids 중 저장된 것만 { id: { n, ms, ok } }. 다른 기기의 traceId는 없으므로 빠진다(=답만 보인다). */
const IDX_CACHE = (globalThis.__argoTraceIdxCache ??= new Map()); // index 경로 → { mtimeMs, items } — 회의실 2.5초 폴이 같은 파일을 매번 파싱하지 않게
async function indexItems(wsId, slug) {
  const f = indexOf(wsId, slug);
  const st = await stat(f).catch(() => null);
  if (!st) { IDX_CACHE.delete(f); return {}; }
  const hit = IDX_CACHE.get(f);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.items;
  const idx = await readJsonLenient(f, null);
  const items = idx && typeof idx.items === 'object' && idx.items ? idx.items : {};
  if (IDX_CACHE.size > 200) IDX_CACHE.clear();
  IDX_CACHE.set(f, { mtimeMs: st.mtimeMs, items });
  return items;
}
export async function traceSummaries(wsId, slug, ids) {
  const want = [...new Set((ids ?? []).filter((x) => TRACE_ID_RE.test(String(x))))];
  if (!want.length) return {};
  const items = await indexItems(wsId, slug);
  return Object.fromEntries(want.filter((id) => items[id]).map((id) => [id, { n: items[id].n, ms: items[id].ms, ok: items[id].ok }]));
}

/* ─── 러너별 매핑 ─── */
/** SDK 모양 메시지 하나를 기록기에 싣는다(순수 + 기록기 부작용) — Claude Agent SDK와 네이티브 엔진이 같은 모양을 낸다.
    assistant: thinking 블록 → 생각, tool_use → 도구 시작(입력 전부). user: tool_result → 그 도구의 결과(tool_use_id로 짝).
    parent_tool_use_id가 있으면 하위 에이전트(Task) 안의 단계다. */
export function recordSdkMessage(trace, msg) {
  if (!trace || !msg) return;
  const parent = msg.parent_tool_use_id ?? null;
  const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
  if (msg.type === 'assistant') {
    if (msg.error) return; // SDK가 API 오류를 싣는 합성 메시지 — 크루의 생각·도구가 아니다(chat.mjs said와 같은 규칙)
    for (const b of content) {
      if (b?.type === 'thinking' && typeof b.thinking === 'string') trace.think(b.thinking, { parent });
      else if (b?.type === 'tool_use') trace.toolStart({ id: b.id ?? null, name: b.name, input: b.input ?? {}, parent });
    }
    if (msg.message?.model) trace.setModel(msg.message.model);
  } else if (msg.type === 'user') {
    for (const b of content) {
      if (b?.type === 'tool_result') trace.toolEnd(b.tool_use_id ?? null, { result: b.content, isError: !!b.is_error });
    }
  }
}

/** codex 항목 → 공통 도구 이름·입력(순수). exec JSONL(snake_case)과 app-server(camelCase) 둘 다 받는다.
    이름은 SDK 도구 이름에 맞춘다(Bash·Edit·WebSearch·mcp__서버__도구) — 러너가 달라도 화면 표기·단계 코드가 같게(러너 중립). */
export function codexItemTool(item) {
  const t = String(item?.type ?? '');
  if (t === 'command_execution' || t === 'commandExecution') return { name: 'Bash', input: { command: item.command ?? '' } };
  if (t === 'file_change' || t === 'fileChange') {
    const changes = (item.changes ?? []).map((c) => ({ path: c?.path ?? '', kind: typeof c?.kind === 'string' ? c.kind : c?.kind?.type ?? '' }));
    return { name: 'Edit', input: { file_path: changes.map((c) => c.path).join(', '), ...(changes.length > 1 || changes[0]?.kind ? { changes: changes.map((c) => `${c.kind ? `${c.kind} ` : ''}${c.path}`).join('\n') } : {}) } };
  }
  if (t === 'mcp_tool_call' || t === 'mcpToolCall') return { name: `mcp__${item.server ?? 'mcp'}__${item.tool ?? 'tool'}`, input: item.arguments ?? {} };
  if (t === 'web_search' || t === 'webSearch') return { name: 'WebSearch', input: { query: item.query ?? item.action?.query ?? '' } };
  if (t === 'dynamicToolCall') return { name: String(item.tool ?? 'tool'), input: item.arguments ?? {} };
  if (t === 'todo_list' || t === 'plan') return { name: 'TodoWrite', kind: 'task', input: t === 'plan' ? { plan: item.text ?? '' } : { todos: (item.items ?? []).map((x) => `${x?.completed ? '[x]' : '[ ]'} ${x?.text ?? ''}`).join('\n') } };
  if (t === 'collab_tool_call' || t === 'collabAgentToolCall') return { name: 'Agent', kind: 'task', input: { tool: item.tool ?? '', prompt: item.prompt ?? '' } };
  return null;
}
function codexItemResult(item) {
  const t = String(item?.type ?? '');
  if (t === 'command_execution' || t === 'commandExecution') {
    const out = item.aggregated_output ?? item.aggregatedOutput ?? '';
    const code = item.exit_code ?? item.exitCode;
    return { result: out, isError: (Number.isFinite(code) && code !== 0) || item.status === 'failed' || item.status === 'declined', ms: item.durationMs ?? null };
  }
  if (t === 'mcp_tool_call' || t === 'mcpToolCall') {
    if (item.error) return { result: String(item.error?.message ?? JSON.stringify(item.error)), isError: true, ms: item.durationMs ?? null };
    return { result: resultText(item.result?.content ?? item.result ?? ''), isError: item.status === 'failed', ms: item.durationMs ?? null };
  }
  if (t === 'file_change' || t === 'fileChange') return { result: (item.changes ?? []).map((c) => c?.diff || `${typeof c?.kind === 'string' ? c.kind : c?.kind?.type ?? ''} ${c?.path ?? ''}`.trim()).join('\n'), isError: item.status === 'failed' || item.status === 'declined' };
  if (t === 'dynamicToolCall') return { result: resultText(item.contentItems ?? ''), isError: item.success === false, ms: item.durationMs ?? null };
  if (t === 'todo_list') return { result: (item.items ?? []).map((x) => `${x?.completed ? '[x]' : '[ ]'} ${x?.text ?? ''}`).join('\n'), isError: false };
  if (t === 'plan') return { result: String(item.text ?? ''), isError: false };
  if (t === 'web_search' || t === 'webSearch') return { result: '', isError: false };
  return { result: '', isError: item?.status === 'failed' };
}

/** codex 이벤트 하나를 기록기에 싣는다. exec JSONL({type:'item.started'|'item.updated'|'item.completed', item})과
    app-server 알림({method:'item/started'|'item/completed', params:{item}}) 둘 다. onText(text) = 크루가 이미 말한 글(쓰는 중인 답). */
export function recordCodexEvent(trace, ev, { onText } = {}) {
  if (!trace || !ev) return;
  const kind = ev.type ?? (ev.method ? String(ev.method).replace('/', '.') : '');
  const item = ev.item ?? ev.params?.item;
  if (!item || !/^item\.(started|updated|completed)$/.test(kind)) return;
  const done = kind === 'item.completed';
  const t = String(item.type ?? '');
  if (t === 'reasoning') {
    if (!done) return;
    const text = typeof item.text === 'string' ? item.text : [...(item.summary ?? []), ...(item.content ?? [])].filter((x) => typeof x === 'string').join('\n');
    trace.think(text);
    return;
  }
  if (t === 'agent_message' || t === 'agentMessage') { if (done && typeof item.text === 'string' && item.text.trim()) onText?.(item.text.trim()); return; }
  const tool = codexItemTool(item);
  if (!tool) return;
  const id = item.id ? `codex:${item.id}` : null;
  trace.toolStart({ id, name: tool.name, input: tool.input, kind: tool.kind ?? null });
  if (done) {
    const r = codexItemResult(item);
    trace.toolEnd(id, { result: r.result, isError: r.isError, name: tool.name, ms: r.ms ?? null });
  }
}
