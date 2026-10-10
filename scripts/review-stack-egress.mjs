// 검수 스택 전용 나가는 연결 기록 — NODE_OPTIONS `--import`로 본체 서버에만 건다(scripts/review-stack.sh).
// `--require`가 아닌 이유: 본체가 macOS Dock 심을 `--require`로 덧붙이는데, `--require`가 둘이면 Next 개발 서버의 작업자 프로세스에서
// 두 경로가 공백으로 이어진 한 경로로 읽혀 작업자가 뜨지 못했다(실측 2026-10-10, 라우트 컴파일 500).
// 목적: 검수 서버가 운영 Supabase(*.supabase.co)로 한 번도 나가지 않았는지 기록으로 확인한다.
// 기록하는 것은 시각·호스트·포트뿐이다(요청 내용·헤더·토큰은 보지 않는다). 파일 = REVIEW_EGRESS_LOG.
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync } from 'node:fs';

const LOG = process.env.REVIEW_EGRESS_LOG;
if (LOG) {
  const seen = new Map(); // host:port → 마지막 기록 시각 — 같은 곳은 10초에 한 줄만
  const note = (kind, host, port) => {
    const h = String(host ?? '').toLowerCase();
    if (!h) return;
    const key = `${kind} ${h}:${port ?? ''}`;
    const now = Date.now();
    if (now - (seen.get(key) ?? 0) < 10_000) return;
    seen.set(key, now);
    try { appendFileSync(LOG, `${new Date(now).toISOString()} pid=${process.pid} ${key}\n`); } catch { /* 기록 실패는 무시 */ }
  };
  const target = (args) => {
    const a = args[0];
    if (a && typeof a === 'object' && !Array.isArray(a)) return [a.host ?? a.hostname ?? (a.path ? `unix:${a.path}` : 'localhost'), a.port];
    if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return [typeof args[1] === 'string' ? args[1] : 'localhost', a];
    if (typeof a === 'string') return [`unix:${a}`, ''];
    return ['?', ''];
  };
  for (const [mod, name, kind] of [[net, 'connect', 'tcp'], [net, 'createConnection', 'tcp'], [tls, 'connect', 'tls']]) {
    const orig = mod[name];
    mod[name] = function patched(...args) {
      try { const [h, p] = target(args); if (!String(h).startsWith('unix:')) note(kind, h, p); } catch { /* 기록 실패는 무시 */ }
      return orig.apply(this, args);
    };
  }
}
