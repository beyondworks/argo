// 작업 과정(turn-trace) 화면 쪽 순수 규칙 — JSX 없이 node --test가 직접 검증한다.
// 진행 폴은 수정 번호(rev)가 커진 단계만 보낸다(src/turn-trace.mjs view). 화면은 그 조각을 번호(i)로 합쳐 목록을 만든다.

/** 폴 응답의 trace 조각을 지금 상태에 합친다(순수). 다른 기록(id가 바뀜)이면 처음부터. 조각이 없으면 상태 유지(null 응답은 호출부가 비운다).
    반환 { id, rev, n, more, steps(번호순) } — 같은 내용이면 prev 참조를 그대로 돌려준다(다시 그리지 않게). */
export function mergeTraceDelta(prev, delta) {
  if (!delta || !delta.id) return prev ?? null;
  const same = prev && prev.id === delta.id;
  if (same && delta.rev === prev.rev && !(delta.steps ?? []).length && delta.n === prev.n) return prev;
  const map = new Map(same ? prev.steps.map((s) => [s.i, s]) : []);
  for (const s of delta.steps ?? []) map.set(s.i, s);
  return {
    id: delta.id, source: delta.source ?? prev?.source ?? '', startedAt: delta.startedAt ?? prev?.startedAt ?? null,
    rev: Math.max(same ? prev.rev : 0, Number(delta.rev) || 0), n: delta.n ?? map.size, more: !!delta.more,
    steps: [...map.values()].sort((a, b) => a.i - b.i),
  };
}

/** 다음 폴에 붙일 쿼리(순수) — 보고 있는 기록과 받은 번호. */
export const traceQuery = (cur) => (cur?.id ? `&tr=${encodeURIComponent(cur.id)}&rev=${Number(cur.rev) || 0}` : '');

/** 걸린 시간 표기(순수) — 1분 4초 / 1m 4s, 10초 미만은 소수 한 자리. t = 사전 함수. */
export function fmtTraceDur(t, ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < 60_000) {
    const s = v < 10_000 ? Math.round(v / 100) / 10 : Math.round(v / 1000);
    return t('trace.dur.s', { s });
  }
  const total = Math.round(v / 1000);
  return t('trace.dur.m', { m: Math.floor(total / 60), s: total % 60 });
}

/** 단계 한 줄 요약(순수) — 도구 이름 + 입력 첫 줄. mcp__서버__도구는 '서버 · 도구'. */
export function stepTitle(step) {
  const name = String(step?.name ?? '');
  const label = name.startsWith('mcp__') ? name.replace(/^mcp__/, '').replace(/__/g, ' · ') : name;
  const first = String(step?.input ?? '').split('\n').find((l) => l.trim()) ?? '';
  return { label, detail: first.length > 140 ? `${first.slice(0, 140)}…` : first };
}

/** 하위 단계(parent)를 부모 바로 아래로 모은다(순수) — 부모가 목록에 없으면 제자리. 반환 [{ step, depth }]. */
export function nestSteps(steps) {
  const list = steps ?? [];
  const ids = new Set(list.filter((s) => s.id).map((s) => s.id));
  const kids = new Map();
  const roots = [];
  for (const s of list) {
    if (s.parent && ids.has(s.parent)) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
    else roots.push(s);
  }
  const out = [];
  const walk = (s, depth) => { out.push({ step: s, depth }); for (const k of kids.get(s.id) ?? []) walk(k, Math.min(depth + 1, 3)); };
  for (const s of roots) walk(s, 0);
  return out;
}
