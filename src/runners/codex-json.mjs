// codex exec `--json` 스트림 읽기 — 작업 과정(turn-trace)에 단계를 싣기 위해 사람용 출력 대신 JSONL을 받는다(2026-10-09).
//
// 실측(핀 0.159.3, 2026-10-09): JSON 모드에서는 사람 모드가 stderr에 찍던 두 줄이 stdout 이벤트로 옮겨 간다.
//   · 경고  — 사람 모드 stderr `warning: <msg>`        → JSON `{"type":"item.completed","item":{"type":"error","message":"<msg>"}}`
//   · 실패  — 사람 모드 stderr `ERROR: <msg>`(두 번)   → JSON `{"type":"error","message":"<msg>"}` + `{"type":"turn.failed","error":{"message":"<msg>"}}`
// 기존 exec 경로의 판정(도구 잠김 CODEX_LOCKUP_RE, 실패 원인 문구 apiError·codexOutdatedError)은 전부 stderr 글을 본다. 그래서 그 두 종류를
// 사람 모드와 같은 줄로 되살려 stderr에 덧붙인다 — 판정 코드는 한 줄도 바꾸지 않고 같은 입력을 받는다. stdout(JSONL)은 판정에 넘기지 않는다
// (사람 모드에서 실패 때 stdout은 비어 있었다 — JSONL을 넘기면 apiError가 경고 항목의 "message"를 원인으로 오인한다).
const LINE_CAP = 8_000_000; // 한 줄 상한 — 거대한 명령 출력 한 줄도 담되 무한히 쌓이지 않게(넘는 줄은 건너뛴다)

/** JSONL 읽기기(순수 + 콜백). push(chunk) — 자식 stdout 조각, end() — 남은 줄 처리, stderr(real) — 사람 모드와 같은 stderr 글. */
export function createCodexJsonReader({ onEvent = null } = {}) {
  let buf = '';
  let skipping = false; // 상한을 넘은 줄을 줄바꿈까지 버리는 중
  const warn = [];
  const errs = [];
  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; } // 비JSON 잡음은 무시(벤더 로그는 stderr로 간다)
    if (ev?.type === 'item.completed' && ev.item?.type === 'error') warn.push(`warning: ${String(ev.item.message ?? '')}`);
    else if (ev?.type === 'error') errs.push(`ERROR: ${String(ev.message ?? '')}`);
    else if (ev?.type === 'turn.failed') errs.push(`ERROR: ${String(ev.error?.message ?? '')}`);
    if (onEvent) { try { onEvent(ev); } catch { /* 표시용 콜백 실패가 턴을 죽이지 않는다 */ } }
  };
  return {
    push(chunk) {
      buf += String(chunk ?? '');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        if (line.trim()) handle(line.trim());
      }
      if (buf.length > LINE_CAP) { buf = ''; skipping = true; }
    },
    end() { const line = skipping ? '' : buf.trim(); buf = ''; skipping = false; if (line) handle(line); },
    /** 사람 모드와 같은 stderr — 실제 stderr(트레이싱 로그 등) 뒤에 되살린 경고·오류 줄. */
    stderr(real = '') { return [String(real ?? '').trimEnd(), ...warn, ...errs].filter(Boolean).join('\n'); },
  };
}

/** JSON 모드 실패 오류를 사람 모드 모양으로(같은 객체를 고쳐 돌려준다) — stderr = 되살린 글, stdout = ''(사람 모드 실패 때와 같다). */
export function humanizeCodexJsonError(e, reader) {
  if (!e || typeof e !== 'object' || !reader) return e;
  reader.end();
  try { e.stderr = reader.stderr(e.stderr); e.stdout = ''; } catch { /* 읽기 전용 — 그대로 */ }
  return e;
}
