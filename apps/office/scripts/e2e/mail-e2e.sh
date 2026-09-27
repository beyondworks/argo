#!/bin/zsh
# 메일 연결 E2E(개발 전용) — 가짜 Google(:58401, 이 스크립트가 새로 띄움) + dev(:5191, dev-fake.sh) + 로컬 스택(58322)
# + ego Space "Argo - 오피스"의 전용 탭(E2E 사용자 mail-e2e@office.test — 실제 계정을 연결해 쓰는 :5190·member@와 섞이지 않게).
# 개인 Gmail 연결 → 회사(Workspace) 추가 → 통합 목록 → 읽기(격리 틀·이미지 차단·첨부) → 공격 메일(이동·끼워 넣기 제거)
# → 읽음·보관 → 답장(초안 자동 저장·스레드·발송) → 관리자 차단·권한 누락 안내 → 만료 → 연결 해제(구글 철회·DB 삭제).
S=${0:A:h}
export PGPASSWORD=postgres
P=(psql -h 127.0.0.1 -p 58322 -U postgres -d postgres -Atq)
F=http://127.0.0.1:58401
fail() { echo "FAIL: $1"; exit 1; }
lsof -ti tcp:58401 -sTCP:LISTEN | xargs kill 2>/dev/null; sleep 0.5
node $S/fake-google.mjs > /dev/null 2>&1 &
for i in {1..20}; do curl -sf $F/log >/dev/null && break; sleep 0.5; done
ctl() { curl -sf -X POST $F/control -d "$1" >/dev/null || fail "control"; }
flog() { curl -sf $F/log; }
B=$("${P[@]}" -c "select id from auth.users where email='mail-e2e@office.test'")
[[ -n $B ]] || fail "E2E user missing — create mail-e2e@office.test (password in ~/.cache/argo-office/e2e-pass)"
PW=$(cat ~/.cache/argo-office/e2e-pass)
APP=http://localhost:5191
"${P[@]}" -c "delete from office_mail_accounts where user_id='$B'"
stage() { local in=$(cat) o; for i in 1 2 3; do o=$(print -r -- "$in" | zsh $S/eg.sh 2>&1); [[ $o == *"timed out: Page.setWebLifecycleState"* ]] || break; sleep 3; done; print -r -- "$o"; }
HEAD='const task = await taskSpace("Argo - 오피스"); const page = (await task.pages()).find((p) => p.label === "p3") ?? await task.newPage(); await page.cdp("Page.setWebLifecycleState", { state: "active" });
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const has = async (s) => { const end = Date.now() + 45000; while (Date.now() < end) { try { if (await page.evaluate((s) => document.body.innerText.includes(s), s)) return; } catch {} await page.waitForTimeout(400); } throw new Error("timeout " + s); }; // 이동 중에도 버틴다
const click = (sel, text) => page.evaluate(([sel, text]) => { const b = [...document.querySelectorAll(sel)].find((x) => x.innerText.includes(text)); if (!b) throw new Error("no " + text); b.click(); }, [sel, text]);'
J() { print -r -- "$1" | grep '^J=' | cut -c3-; }

# 0) E2E 사용자로 로그인(이 탭만 — :5191은 따로 저장소)
O0=$(stage <<JS
$HEAD
await page.goto("$APP/me/mail", { timeout: 60000 });
await page.waitForTimeout(2500);
if (await page.evaluate(() => !!document.querySelector("input[type=password]"))) {
  await page.fill("input[type=email]", "mail-e2e@office.test"); await page.fill("input[type=password]", "$PW");
  await page.click("button[type=submit]"); await has("계정 추가").catch(() => {}); await has("메일");
}
console.log("J=" + JSON.stringify(await page.evaluate(() => document.querySelector(".space-switch, .sidebar")?.innerText.includes("mail-e2e@office.test"))));
JS
); [[ $(J "$O0") == true ]] || { print -r -- "$O0" | tail -3; fail "e2e login"; }

# 1) 개인 Gmail 연결
ctl '{"email":"owner@gmail.example","name":"김유건"}'
O=$(stage <<JS
$HEAD
await page.goto("$APP/me/mail", { timeout: 60000 });
await has("Google로 연결");
const admin = await page.evaluate(() => !!document.querySelector(".mail-connect .link-btn"));
await click(".mail-connect .btn", "Google로 연결");
await has("FAKE-gmail.example 수정 견적");
console.log("J=" + JSON.stringify({ admin, url: await page.url() }));
JS
); J1=$(J "$O"); echo "1: $J1"; [[ $J1 == *'"url":"'$APP'/me/mail"'* && $J1 == *'"admin":true'* ]] || { print -r -- "$O" | tail -3; fail "connect personal"; }
[[ $("${P[@]}" -c "select count(*) from office_mail_accounts a join office_mail_secrets s on s.account_id=a.id where a.user_id='$B' and a.address='owner@gmail.example' and s.sealed like 'v1.%' and s.access_sealed like 'v1.%' and a.hosted_domain is null") == 1 ]] || fail "personal account row"
flog | grep -q '"prompt":"consent","access_type":"offline"' || fail "auth params (offline+consent)"

# 2) 회사(Workspace) 계정 추가 → 통합 목록에 둘 다, 회사 표시
ctl '{"email":"kim@corp.example","name":"김회사","hd":"corp.example"}'
O=$(stage <<JS
$HEAD
await click(".mail-accounts .nav-item", "계정 추가");
await has("FAKE-corp.example 수정 견적");
await has("FAKE-gmail.example 수정 견적");
console.log("J=" + JSON.stringify(await page.evaluate(() => ({ accounts: [...document.querySelectorAll(".mail-account-name")].map((a) => a.innerText.replace(/\s+/g, " ")), tags: [...document.querySelectorAll(".mail-tag")].map((x) => x.innerText) }))));
JS
); J2=$(J "$O"); echo "2: $J2"; [[ $J2 == *'kim@corp.example 회사'* && $J2 == *'corp.example'* && $J2 == *'gmail.example'* ]] || { print -r -- "$O" | tail -3; fail "add workspace"; }

# 3) 읽기 — 격리 틀(스크립트 무효), 바깥 이미지 차단 안내, 첨부, 읽음 반영
O=$(stage <<JS
$HEAD
await click(".mail-row", "FAKE-gmail.example 수정 견적");
await page.waitForSelector(".mail-frame", { timeout: 30000 });
await page.waitForTimeout(1500);
console.log("J=" + JSON.stringify(await page.evaluate(() => { const f = document.querySelector(".mail-frame"); const d = new DOMParser().parseFromString(f.srcdoc, "text/html"); const av = d.querySelector("img[alt=avatar]");
  return { sandbox: f.getAttribute("sandbox"), csp: /img-src data: https: http:/.test(f.srcdoc), title: document.title, att: [...document.querySelectorAll(".mail-atts .chip")].map((c) => c.innerText.replace(/\s+/g, " ")), from: document.querySelector(".reader-meta b")?.innerText,
    cid: av?.getAttribute("src").startsWith("data:image/png;base64,"), avatar: av && [av.style.width, av.style.height, av.style.borderRadius].join(" "), amp: d.body.textContent.includes("Chairman & CEO") && !f.srcdoc.includes("&amp;amp;"), trackerQ: d.querySelector("img[src*=tracker]")?.getAttribute("src") }; })));
JS
); J3=$(J "$O"); echo "3: $J3"; [[ $J3 == *'"sandbox":"allow-popups allow-popups-to-escape-sandbox"'* && $J3 == *'"csp":true'* && $J3 != *HACKED* && $J3 == *'"att":["견적서.pdf'*'"]'* && $J3 != *logo.png* && $J3 == *'"from":"박지현"'* && $J3 == *'"cid":true'* && $J3 == *'"avatar":"88px 88px 50%"'* && $J3 == *'"amp":true'* && $J3 == *'pixel.png?e=1&v=2'* ]] || { print -r -- "$O" | tail -3; fail "read"; }

# 3c) 첨부는 새 탭에서 바로(PDF), 본문 링크는 새 탭으로 열린다
O=$(stage <<JS
$HEAD
const pop1 = page.waitForEvent("popup", { timeout: 20000 });
await page.click(".mail-atts .chip", { label: "open pdf attachment" });
const t1 = await pop1; await page.waitForTimeout(1500);
const u1 = await t1.url(); const ct = await t1.evaluate(() => document.contentType).catch(() => "?"); await t1.close();
// 메일 틀은 별도 프로세스라 안쪽 위치를 읽을 수 없다 — 같은 mailDoc·같은 sandbox로 링크가 틀을 가득 채운 시험 틀을 띄워 가운데를 누른다
const at = await page.evaluate(async () => {
  const m = await import("/src/core/mail.js");
  const f = document.createElement("iframe"); f.className = "probe-link"; f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
  f.srcdoc = m.mailDoc('<a id="open" style="display:block;height:160px;background:#ddd" href="http://127.0.0.1:58401/hit-link-open">링크</a>');
  f.style.cssText = "position:fixed;left:40px;top:40px;width:300px;height:200px;z-index:99999;border:0";
  document.body.append(f); await new Promise((ok) => setTimeout(ok, 800)); return { x: 190, y: 120 };
});
const pop2 = page.waitForEvent("popup", { timeout: 20000 });
await page.mouse.click(at.x, at.y, { label: "click link in mail" });
let u2 = ""; try { const t2 = await pop2; await page.waitForTimeout(1000); u2 = await t2.url(); await t2.close(); } catch (e) { u2 = "none"; }
await page.evaluate(() => document.querySelector(".probe-link")?.remove());
console.log("J=" + JSON.stringify({ u1: u1.slice(0, 5), ct, u2 }));
JS
); J3c=$(J "$O"); echo "3c: $J3c"; [[ $J3c == *'"u1":"blob:"'* && $J3c == *'"ct":"application/pdf"'* && $J3c == *'"u2":"http://127.0.0.1:58401/hit-link-open"'* ]] || { print -r -- "$O" | tail -3; fail "attachment/link open"; }
flog | grep -q '"path":"/hit-link-open"' || fail "link did not reach its page"
for i in {1..20}; do flog | grep -qE '"id":"m1","add":\[[^]]*\],"remove":\["UNREAD"' && break; sleep 1; done
flog | grep -qE '"id":"m1","add":\[[^]]*\],"remove":\["UNREAD"' || fail "mark read not sent"

# 3b) 공격 메일 — 이동(meta refresh·base)·끼워 넣기(link·form)가 틀에 들어가지 않고, 외부 요청이 0건. 위험 링크는 href 제거.
#     대조군: 같은 공격 HTML을 걷어내지 않고 같은 sandbox·CSP로 띄우면 무엇이 새는지 함께 기록한다(검사가 새는 것을 잡을 수 있는지 확인).
O=$(stage <<JS
$HEAD
await click(".mail-row", "NAVTEST owner@gmail.example");
await page.waitForSelector(".mail-frame", { timeout: 30000 });
await page.waitForTimeout(3500);
const r = await page.evaluate(() => { const d = document.querySelector(".mail-frame").srcdoc; return { meta: /http-equiv="refresh"/i.test(d), base: /<base href/i.test(d), link: /<link/i.test(d), form: /<form/i.test(d), js: /javascript:/i.test(d), body: d.includes("본문 NAVTEST") }; });
const ctlr = await page.evaluate(async () => {
  const m = await import("/src/core/mail.js");
  const attack = '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:58401/hit-ctl-refresh"><link rel="stylesheet" href="http://127.0.0.1:58401/hit-ctl-link.css"><img src="http://127.0.0.1:58401/hit-ctl-img">';
  const raw = m.mailDoc("").replace("<body>", "<body>" + attack); // 걷어내기 없이, 같은 CSP
  const f = document.createElement("iframe"); f.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox"); f.srcdoc = raw; f.style.cssText = "position:fixed;left:-9999px;width:10px;height:10px";
  document.body.append(f); await new Promise((ok) => setTimeout(ok, 3000)); f.remove(); return true;
});
console.log("J=" + JSON.stringify(r));
JS
); J3b=$(J "$O"); echo "3b: $J3b"; [[ $J3b == '{"meta":false,"base":false,"link":false,"form":false,"js":false,"body":true}' ]] || { print -r -- "$O" | tail -3; fail "attack tags not stripped"; }
HITS=$(flog | node -e 'const l=JSON.parse(require("fs").readFileSync(0)).log.filter((x)=>x.t==="hit").map((x)=>x.path); console.log(JSON.stringify(l))')
echo "hits: $HITS"
[[ $HITS != *'"/hit-refresh"'* && $HITS != *'/hit-base'* && $HITS != *'hit-link.css"'* && $HITS != *'"/hit-form"'* ]] || fail "attack mail reached network"
[[ $HITS == *'hit-ctl-img'* ]] || fail "control: probe did not see the allowed image — the check cannot detect leaks"

# 4) 보관 → INBOX 제거
O=$(stage <<JS
$HEAD
await click(".mail-row", "FAKE-gmail.example 수정 견적");
await page.waitForSelector(".mail-frame", { timeout: 30000 });
await click(".reader-actions .btn", "보관");
await page.waitForFunction(() => ![...document.querySelectorAll(".mail-row")].some((b) => b.innerText.includes("FAKE-gmail.example 수정 견적")), undefined, { timeout: 20000 });
console.log("J=ok");
JS
); [[ $O == *J=ok* ]] || { print -r -- "$O" | tail -3; fail "archive ui"; }
for i in {1..20}; do flog | grep -qE '"email":"owner@gmail.example","id":"m1","add":\[\],"remove":\[[^]]*"INBOX"' && break; sleep 1; done
flog | grep -qE '"email":"owner@gmail.example","id":"m1","add":\[\],"remove":\[[^]]*"INBOX"' || fail "archive not sent"

# 5) 답장 — 회사 메일에서, 초안 자동 저장 뒤 보내기(같은 스레드·In-Reply-To, 초안 삭제)
O=$(stage <<JS
$HEAD
await click(".mail-row", "FAKE-corp.example 수정 견적");
await page.waitForSelector(".mail-frame", { timeout: 30000 }); await page.waitForTimeout(800);
await click(".reader-actions .btn", "답장");
await page.waitForSelector(".compose-body", { timeout: 20000 });
await page.fill(".compose-body", "확인했습니다. 금요일까지 회신드리겠습니다.");
await page.waitForFunction(() => document.querySelector(".modal-foot")?.innerText.includes("자동 저장"), undefined, { timeout: 20000 });
await click(".modal-foot .btn", "보내기");
await page.waitForFunction(() => !document.querySelector(".compose-body") && document.querySelector(".toast")?.innerText.includes("보냈습니다"), undefined, { timeout: 20000 });
console.log("J=ok");
JS
); [[ $O == *J=ok* ]] || { print -r -- "$O" | tail -3; fail "reply ui"; }
node -e '
const l = JSON.parse(process.argv[1]).log;
const s = l.find((x) => x.t === "send");
const bad = [!l.some((x) => x.t === "draft.create" && x.email === "kim@corp.example") && "draft not autosaved to corp account",
  !s && "not sent", s && s.email !== "kim@corp.example" && "sent from wrong account", s && s.threadId !== "t1" && "not in thread",
  s && !/In-Reply-To: <m1-kim@corp.example@hanbit.example>/.test(s.raw) && "no In-Reply-To", s && !/^To: jihyun@hanbit.example/m.test(s.raw) && "wrong To",
  s && Buffer.from(s.raw.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString() !== "확인했습니다. 금요일까지 회신드리겠습니다." && "body mismatch",
  !l.some((x) => x.t === "draft.delete") && "draft not deleted after send"].filter(Boolean);
if (bad.length) { console.log(bad.join("; ")); process.exit(1); }' "$(flog)" || fail "reply assertions"

# 6) 회사 관리자 차단 / 7) 권한 일부 끔 → 안내, 받은 토큰 철회
for C in '{"deny":"admin_policy_enforced"}|회사 관리자가 외부 앱 연결을 막았습니다' '{"email":"half@gmail.example","dropScope":true}|필요한 권한이 빠졌습니다'; do
  ctl "${C%%|*}"
  O=$(stage <<JS
$HEAD
await page.goto("$APP/me/mail", { timeout: 60000 });
await has("계정 추가");
await click(".mail-accounts .nav-item", "계정 추가");
await has("${C#*|}");
console.log("J=" + JSON.stringify({ copy: await page.evaluate(() => !!document.querySelector(".mail-connect .link-btn")) }));
JS
); [[ $(J "$O") == *'"copy":true'* ]] || { print -r -- "$O" | tail -3; fail "error screen ${C#*|}"; }
done
flog | grep -q '"t":"revoke","ok":true' || fail "partial-scope token not revoked"
[[ $("${P[@]}" -c "select count(*) from office_mail_accounts where user_id='$B'") == 2 ]] || fail "failed connects must not add accounts"

# 8) 만료(테스트 상태 앱 7일) → 다시 연결 안내
ctl '{"expire":true}'
"${P[@]}" -c "update office_mail_secrets set access_expires = now() - interval '1 minute' where account_id in (select id from office_mail_accounts where user_id='$B' and address='owner@gmail.example')"
O=$(stage <<JS
$HEAD
await page.goto("$APP/me/mail", { timeout: 60000 });
await has("연결이 만료됐습니다");
console.log("J=" + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".mail-account")].map((a) => a.innerText.replace(/\s+/g, " ")))));
JS
); J8=$(J "$O"); echo "8: $J8"; [[ $J8 == *'owner@gmail.example 다시 연결'* ]] || { print -r -- "$O" | tail -3; fail "expired ui"; }
[[ $("${P[@]}" -c "select status from office_mail_accounts where user_id='$B' and address='owner@gmail.example'") == expired ]] || fail "expired not stored"
ctl '{}'

# 9) 연결 해제(회사) → 구글 철회 + DB 삭제
O=$(stage <<JS
$HEAD
await page.evaluate(() => { const row = [...document.querySelectorAll(".mail-account")].find((a) => a.innerText.includes("kim@corp.example")); row.querySelector(".icon-btn").click(); });
await page.waitForSelector("[role=menu] button", { timeout: 20000 });
await click("[role=menu] button", "연결 해제");
await page.waitForSelector(".modal .btn.danger", { timeout: 20000 });
const title = await page.evaluate(() => document.querySelector(".modal-head h2").innerText);
await page.evaluate(() => document.querySelector(".modal .btn.danger").click());
await page.waitForFunction(() => ![...document.querySelectorAll(".mail-account")].some((a) => a.innerText.includes("kim@corp.example")), undefined, { timeout: 20000 });
console.log("J=" + JSON.stringify({ title }));
JS
); [[ $O == *'kim@corp.example 연결을 해제할까요?'* ]] || { print -r -- "$O" | tail -3; fail "disconnect ui"; }
[[ $("${P[@]}" -c "select count(*) from office_mail_accounts where user_id='$B' and address='kim@corp.example'") == 0 ]] || fail "corp row remains"
[[ $(flog | grep -o '"t":"revoke","ok":true' | wc -l | tr -d ' ') -ge 2 ]] || fail "disconnect did not revoke"
echo PASS
