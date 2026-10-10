#!/usr/bin/env bash
# Supabase 조직 사용량 점검(읽기 전용) — 이번 청구 주기의 항목별 사용량·30일 추정·한도 대비, 일별 전송량(종류별).
# 2026-10-10 유건 지시: 게이트웨이 폴링이 전송량 한도(250GB) 초과 직전까지 간 것을 발행 보고 끝에서야 알았다. 매일·발행 전마다 이걸로 본다.
# 사용: bash scripts/supabase-usage.sh [조직 slug]   — 추정이 한도의 80%를 넘는 항목이 있으면 종료코드 2, 과금 항목(capped=false)에 비용이 있으면 3.
# 인증: ego-browser 기본 프로필의 Supabase 대시보드 로그인(argo 조직 권한 계정)을 쓴다. 관리 API 토큰(CLI)은 사용량 권한이 없다(403, 10/10 확인).
# 토큰·키는 출력하지 않는다. 로그인이 풀려 있으면 종료코드 4와 안내만 낸다.
set -euo pipefail
ORG="${1:-frnwqefpgyzhsqmivera}"
OUT=$(sed "s/__ORG__/$ORG/" <<'JS' | ego-browser nodejs 2>&1
const org = "__ORG__";
const task = await taskSpace("Argo 사용량 점검");
try {
  const page = task.page("p1");
  await page.goto(`https://supabase.com/dashboard/org/${org}/usage`);
  await page.waitForTimeout(4000);
  if ((await page.url()).includes("/sign-in")) { console.log("NOLOGIN"); }
  else {
    const r = await page.evaluate(async (org) => {
      let tok = null;
      for (const k of Object.keys(localStorage).filter((k) => k.includes("auth"))) { try { tok = JSON.parse(localStorage.getItem(k)).access_token || tok; } catch {} }
      const get = async (p) => { const res = await fetch(`https://api.supabase.com/platform/organizations/${org}/${p}`, { headers: { Authorization: "Bearer " + tok } }); return res.ok ? res.json() : { error: res.status }; };
      const sub = await get("billing/subscription");
      const start = sub?.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null;
      const end = sub?.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      const usage = await get("usage");
      const daily = start ? await get(`usage/daily?start=${encodeURIComponent(start)}&end=${encodeURIComponent(new Date().toISOString())}`) : { usages: [] };
      return { start, end, usage, daily };
    }, org);
    console.log("JSON " + JSON.stringify(r));
  }
} finally { await task.finish({ keep: [] }); }
JS
)
case "$OUT" in *NOLOGIN*) echo "Supabase 대시보드 로그인이 풀려 있습니다 — ego-browser에서 argo 조직 권한 계정으로 다시 로그인한 뒤 실행하세요"; exit 4;; esac
printf '%s\n' "$OUT" | sed -n 's/^JSON //p' | node --input-type=module -e '
let s = ""; for await (const c of process.stdin) s += c;
const { start, end, usage, daily } = JSON.parse(s);
if (!start || !usage?.usages) { console.log("사용량을 읽지 못했습니다:", JSON.stringify(usage).slice(0, 200)); process.exit(4); }
const t0 = Date.parse(start), t1 = Date.parse(end), now = Date.now();
const frac = Math.max((now - t0) / (t1 - t0), 1 / 30);
const fmt = (m, v) => /EGRESS|SIZE|INGESTION|QUERYING/.test(m) ? (v / 1e9).toFixed(1) + "GB" : Math.round(v).toLocaleString("en");
console.log(`청구 주기 ${start.slice(0, 10)} ~ ${end.slice(0, 10)} (${Math.round(frac * 100)}% 지남)`);
let warn = false, billed = false;
for (const u of usage.usages) {
  const v = u.usage_original ?? 0; if (!v) continue;
  const quota = u.pricing_free_units ? u.pricing_free_units * (/EGRESS|SIZE|INGESTION|QUERYING/.test(u.metric) ? 1e9 : 1) : null;
  const proj = /SIZE|PEAK|MONTHLY_ACTIVE/.test(u.metric) ? v : v / frac;
  const pct = quota ? Math.round((proj / quota) * 100) : null;
  const flag = pct != null && pct >= 80 ? "  <-- 추정 " + pct + "%" : "";
  if (flag) warn = true;
  if (u.capped === false && u.cost > 0) billed = true;
  console.log(`${u.metric.padEnd(30)} ${fmt(u.metric, v).padStart(12)}  30일 추정 ${fmt(u.metric, proj).padStart(12)}${quota ? "  한도 " + fmt(u.metric, quota) : ""}${u.cost ? "  비용 $" + u.cost : ""}${u.capped === false ? " (과금)" : ""}${flag}`);
}
const days = {};
for (const u of daily.usages ?? []) if (u.metric === "EGRESS") days[u.date] = u;
const ds = Object.keys(days).sort().slice(-7);
if (ds.length) {
  console.log("\n최근 7일 전송량(GB) 전체 / REST / Storage / Auth / Realtime / 함수");
  for (const d of ds) { const u = days[d], b = u.breakdown ?? {}, g = (x) => ((x ?? 0) / 1e9).toFixed(2); console.log(`${d}  ${g(u.usage_original)} / ${g(b.egress_rest)} / ${g(b.egress_storage)} / ${g(b.egress_auth)} / ${g(b.egress_realtime)} / ${g(b.egress_function)}`); }
}
if (warn) { console.log("\n경고: 한도 80%를 넘을 항목이 있습니다 — 호출 상위(edge_logs)를 먼저 보세요"); process.exit(2); }
if (billed) { console.log("\n주의: 한도 없이 과금되는 항목에 비용이 있습니다"); process.exit(3); }
'
