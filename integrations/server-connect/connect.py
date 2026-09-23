#!/usr/bin/env python3
# Argo 메신저 — VPS 서버 연결(유건 지시 2026-09-23). 서버 콘솔의 브라우저 터미널에 명령 한 줄을 붙여넣으면 이 스크립트가 돈다:
#   curl -fsSL <msgr-bot 주소>/connect | python3 - <연결 코드> <msgr-bot 주소>
# 하는 일은 앱의 "이 컴퓨터의 헤르메스 불러오기"(apps/messenger/src-tauri/src/agents.rs)와 같다 — 이 서버에서:
#   1) 헤르메스 프로필·오픈클로 에이전트를 찾고  2) 에이전트마다 봇 토큰을 **여기서** 만들어 해시만 보고하고
#   3) 앱에서 관리자가 고른 에이전트에만 플러그인·.env·게이트웨이 재시작을 한다.
# 토큰 원문은 이 서버의 에이전트 설정(.env 0600 / openclaw.json)에만 쓰고, 화면·네트워크·로그로 내보내지 않는다.
# 표준 라이브러리만 쓴다(VPS 기본 이미지에 추가 설치 없이). 소스 정본은 이 파일, 배포본은 scripts/build-server-connect.mjs가 만든다.
import base64, hashlib, json, os, pwd, re, secrets, shlex, socket, subprocess, sys, tempfile, time, urllib.error, urllib.request

BASE = "__ARGO_MSGR_URL__"   # 두 번째 인자(앱이 명령에 넣는 공개 주소 …/functions/v1/msgr-bot)가 정본, 없으면 엣지 함수가 넣은 값
BASE_RE = re.compile(r"^https?://[A-Za-z0-9.-]+(:[0-9]+)?/functions/v1/msgr-bot$")
PLUGINS = {}                  # {"hermes": {상대경로: base64}, "openclaw": {...}} — 빌드가 채운다
CODE_RE = re.compile(r"^argo_link_[0-9a-f]{48}$")
ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
POLL_S, WAIT_S, CMD_TIMEOUT = 3, 60 * 60, 90
DEFER = os.environ.get("ARGO_CONNECT_DEFER", "")  # root가 에이전트 계정으로 넘겨 돌릴 때: 시스템 서비스 재시작은 root가 맡는다(결과 파일로 넘김)
DEFERRED = {}  # 프로필 id → 재시작을 root에게 넘긴 systemd 서비스 이름


def say(ko, en):
    print(f"{ko}\n  ({en})", flush=True)


def redact(text):
    return re.sub(r"argo_bot_[A-Za-z0-9_]*", "[redacted]", text or "")


def cli_dirs():
    h = os.path.expanduser("~")
    return os.environ.get("PATH", "").split(os.pathsep) + [os.path.join(h, ".local/bin"), os.path.join(h, ".npm-global/bin"), "/usr/local/bin", "/usr/bin", "/bin"]


def find_cli(name):
    for d in cli_dirs():
        p = os.path.join(d, name)
        if d and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def run(cli, args, env=None):
    e = dict(os.environ, PATH=os.pathsep.join(cli_dirs()), NO_COLOR="1", FORCE_COLOR="0", **(env or {}))
    try:
        r = subprocess.run([cli, *args], env=e, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=CMD_TIMEOUT)
    except subprocess.TimeoutExpired:
        return False, "timeout"
    except OSError as ex:
        return False, f"spawn failed: {ex}"
    return r.returncode == 0, redact(r.stdout if r.returncode == 0 else r.stdout + r.stderr)


def parse_hermes_profiles(out):
    """`hermes profile list` 표에서 프로필 이름(◆ = 기본). agents.rs parse_hermes_profiles와 같은 규칙."""
    v = []
    for line in out.splitlines():
        t = line.strip()
        if not t or t.startswith("Profile") or t.startswith("─") or t.startswith("-"):
            continue
        is_default = t.startswith("◆")
        rest = t[1:].strip() if is_default else t
        name = re.sub(r"^[^A-Za-z0-9._-]+|[^A-Za-z0-9._-]+$", "", (rest.split() or [""])[0])
        if name and re.fullmatch(r"[A-Za-z0-9._-]+", name):
            v.append((name, is_default))
    return v


def parse_openclaw_agents(out):
    """`openclaw agents list`의 "- <id> (default)" 줄. agents.rs parse_openclaw_agents와 같은 규칙."""
    v = []
    for line in out.splitlines():
        t = line.strip()
        if not t.startswith("- "):
            continue
        rest = t[2:]
        aid = (rest.split() or [""])[0]
        if aid and re.fullmatch(r"[A-Za-z0-9._-]+", aid):
            v.append((aid, "(default)" in rest))
    return v


def hermes_home(cli, name):
    ok, out = run(cli, ["profile", "show", name])
    for line in out.splitlines():
        if line.strip().startswith("Path:"):
            return line.strip()[5:].strip()
    h = os.path.expanduser("~")
    return os.path.join(h, ".hermes") if name == "default" else os.path.join(h, ".hermes/profiles", name)


def gateway_running(status):
    s = status.lower()
    return any(k in s for k in ("gateway is running", "gateway is supervised by launchd", "gateway service is running", "gateway process running"))


def list_agents():
    agents, clis = [], {}
    cli = find_cli("hermes")
    if cli:
        ok, out = run(cli, ["profile", "list"])
        if ok:
            clis["hermes"] = cli
            for name, d in parse_hermes_profiles(out):
                agents.append({"kind": "hermes", "id": name, "name": "Hermes" if name == "default" else name, "default": d, "home": hermes_home(cli, name)})
    cli = find_cli("openclaw")
    if cli:
        ok, out = run(cli, ["agents", "list"])
        if ok:
            clis["openclaw"] = cli
            for aid, d in parse_openclaw_agents(out):
                agents.append({"kind": "openclaw", "id": aid, "name": "OpenClaw" if aid == "main" else aid, "default": d})
    return [a for a in agents if ID_RE.match(a["id"])][:50], clis


def post(path, payload):
    req = urllib.request.Request(f"{BASE}/{path}", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read() or b"null") or {}
        except ValueError:
            body = {}
        raise RuntimeError(body.get("description") or f"HTTP {e.code}")


def write_plugin(kind, dst):
    for rel, b64 in PLUGINS.get(kind, {}).items():
        p = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(base64.b64decode(b64))
    return len(PLUGINS.get(kind, {}))


def upsert_env(text, pairs):
    lines = text.splitlines()
    for k, v in pairs:
        i = next((n for n, l in enumerate(lines) if l.lstrip().startswith(f"{k}=")), None)
        if i is None:
            lines.append(f"{k}={v}")
        else:
            lines[i] = f"{k}={v}"
    return "\n".join(lines) + "\n"


def write_env(path, pairs):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cur = open(path, encoding="utf-8").read() if os.path.exists(path) else ""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(upsert_env(cur, pairs))
    os.chmod(path, 0o600)


def merge_binding(bindings, aid):
    keep = [b for b in bindings if not (isinstance(b, dict) and b.get("match", {}).get("channel") == "argo-msgr" and b["match"].get("accountId") == aid and len(b["match"]) == 2)]
    return keep + [{"match": {"channel": "argo-msgr", "accountId": aid}, "agentId": aid}]


def gateway_unit(status):
    """게이트웨이가 systemd 시스템 서비스로 돌면 그 서비스 이름. `hermes gateway status`의 PID로 찾는다(실측 2026-09-23 Hostinger VPS:
    com.ai-native.hermes-gateway@<프로필>.service, 헤르메스는 이를 "Running manually"로 보고 `gateway restart`로는 못 건드린다)."""
    m = re.search(r"PID:?\s*(\d+)", status or "")
    if not m:
        return None
    try:
        unit = subprocess.run(["ps", "-o", "unit=", "-p", m.group(1)], capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    return unit if unit.endswith(".service") and not unit.startswith("user@") else None


def restart_unit(unit, aid):
    if os.geteuid() == 0:
        return run("systemctl", ["restart", unit])
    if DEFER:
        DEFERRED[aid] = unit
        return True, f"restart {unit} (root)"
    ok, out = run("sudo", ["-n", "systemctl", "restart", unit])
    if ok:
        return ok, out
    return False, f"{unit} 재시작에는 관리자 권한이 필요합니다 — 서버 터미널을 연 그대로(root) 다시 실행하면 자동으로 재시작합니다 / needs root: run again as root"


def install_hermes(cli, a, token):
    home = a.get("home") or os.path.expanduser("~/.hermes")
    write_plugin("hermes", os.path.join(home, "plugins/argo-msgr"))
    write_env(os.path.join(home, ".env"), [("ARGO_MSGR_URL", BASE), ("ARGO_MSGR_BOT_TOKEN", token)])
    env = {"HERMES_HOME": home}
    ok, out = run(cli, ["plugins", "enable", "argo-msgr-platform", "--no-allow-tool-override"], env)
    if not ok:
        return False, out
    _, st = run(cli, ["gateway", "status"], env)
    unit = gateway_unit(st)
    if unit:  # systemd 서비스가 띄운 게이트웨이 — 서비스를 재시작해야 새 .env(EnvironmentFile)를 읽는다. `hermes gateway install`을 부르면 게이트웨이가 둘이 된다
        return restart_unit(unit, a["id"])
    if gateway_running(st):
        return run(cli, ["gateway", "restart"], env)
    ok, out = run(cli, ["gateway", "install"], env)
    return run(cli, ["gateway", "start"], env) if ok else (False, out)


def install_openclaw(cli, agents, tokens):
    results = {}
    write_plugin("openclaw", os.path.expanduser("~/.openclaw/extensions/openclaw-argo-msgr"))
    ok, out = run(cli, ["plugins", "enable", "openclaw-argo-msgr"])
    if not ok:
        return {a["id"]: (False, out) for a in agents}
    for a in agents:
        base = f"channels.argo-msgr.accounts[{a['id']}]"
        err = None
        for k, v in (("url", BASE), ("token", tokens[a["id"]]), ("enabled", "true")):
            ok, out = run(cli, ["config", "set", f"{base}.{k}", v])
            if not ok:
                err = out; break
        if err is not None:
            results[a["id"]] = (False, err); continue
        ok, out = run(cli, ["config", "get", "bindings", "--json"])
        try:
            bindings = json.loads(out) if ok else ([] if out.strip() == "Config path not found: bindings" else None)
        except ValueError:
            bindings = None
        if bindings is None:
            results[a["id"]] = (False, out or "Invalid bindings config"); continue
        results[a["id"]] = run(cli, ["config", "set", "bindings", json.dumps(merge_binding(bindings, a["id"]))])
    if all(ok for ok, _ in results.values()):
        g = run(cli, ["gateway", "restart"])
        if not g[0]:
            i = run(cli, ["gateway", "install"])
            g = run(cli, ["gateway", "start"]) if i[0] else (False, f"{g[1]}\n{i[1]}")
        results = {k: g for k in results}
    return results


def agent_users():
    """헤르메스·오픈클로 설정이 있는 일반 계정(uid ≥ 1000). 서버 콘솔 터미널은 보통 root로 열리는데, 게이트웨이는 다른 계정에서 돈다."""
    return [p for p in pwd.getpwall() if p.pw_uid >= 1000 and p.pw_dir and any(os.path.isdir(os.path.join(p.pw_dir, d)) for d in (".hermes", ".openclaw"))]


def handoff(user, code):
    """root로 실행됐을 때: 같은 스크립트를 에이전트 계정으로 다시 돌리고(설정 파일 소유권이 그 계정으로 남는다), 시스템 서비스 재시작만 root가 한다."""
    say(f"에이전트가 '{user.pw_name}' 계정에 있어 그 계정으로 이어서 진행합니다…", f"Agents live under '{user.pw_name}' — continuing as that user…")
    try:
        with urllib.request.urlopen(f"{BASE}/connect", timeout=30) as r:
            src = r.read()
    except (urllib.error.URLError, OSError) as e:
        say(f"스크립트를 다시 받지 못했습니다: {e}", f"Could not fetch the script again: {e}"); return 4
    work = tempfile.mkdtemp(prefix="argo-connect-")
    script, result = os.path.join(work, "connect.py"), os.path.join(work, "result.json")
    try:
        with open(script, "wb") as f:
            f.write(src)
        os.chmod(work, 0o700); os.chown(work, user.pw_uid, user.pw_gid)
        os.chmod(script, 0o600); os.chown(script, user.pw_uid, user.pw_gid)
        cmd = " ".join(shlex.quote(x) for x in ["env", f"ARGO_CONNECT_DEFER={result}", "python3", script, code, BASE])
        rc = subprocess.call(["runuser", "-l", user.pw_name, "-c", cmd])
        if rc != 0 or not os.path.exists(result):
            return rc or 3
        with open(result, encoding="utf-8") as f:
            done = json.load(f)
    finally:
        subprocess.call(["rm", "-rf", work])
    for r in done["results"]:
        unit = r.pop("unit", None)
        if unit:
            ok, out = run("systemctl", ["restart", unit])
            r["ok"], r["detail"] = ok, (out or f"restarted {unit}")[-300:]
    return finish(code, done["results"], {tuple(k.split(":", 1)): v for k, v in done["names"].items()})


def finish(code, results, names):
    try:
        post("link/done", {"code": code, "results": results})
    except RuntimeError:
        pass  # 결과 보고 실패는 연결 자체를 되돌리지 않는다 — 앱은 봇의 접속 시각으로도 상태를 본다
    for r in results:
        print(f"  {'OK ' if r['ok'] else 'X  '} {names[(r['kind'], r['id'])]}" + ("" if r["ok"] else f" — {r['detail'][-160:]}"))
    failed = [r for r in results if not r["ok"]]
    if failed:
        say(f"{len(failed)}명은 연결하지 못했습니다. 위 내용을 확인한 뒤 앱에서 다시 시도해 주세요.", f"{len(failed)} agent(s) failed. Check the messages above and retry from the app."); return 7
    say("완료되었습니다. 앱에서 에이전트가 '연결됨'으로 바뀌면 채널에 추가해 쓰면 됩니다.", "Done. Once the agents show as connected in the app, add them to a channel.")
    return 0


def main(argv):
    global BASE
    code = (argv[1] if len(argv) > 1 else os.environ.get("ARGO_LINK_CODE", "")).strip()
    if len(argv) > 2 and BASE_RE.match(argv[2].strip()):
        BASE = argv[2].strip()
    if not CODE_RE.match(code) or not BASE_RE.match(BASE):
        say("연결 코드가 없거나 형식이 다릅니다. 앱에서 명령을 다시 복사해 주세요.", "Missing or invalid connection code — copy the command from the app again."); return 2
    say("이 서버의 에이전트를 찾는 중…", "Looking for agents on this server…")
    # root로 실행됐으면(서버 콘솔 기본) 에이전트가 사는 일반 계정을 먼저 본다 — root 자신에게도 빈 헤르메스 기본 프로필이 있을 수 있다
    # (실측 2026-09-23 Hostinger: /root/.hermes 기본 프로필만 잡혀 crew의 11명을 못 찾았다). root에만 에이전트가 있으면 그대로 진행.
    if os.geteuid() == 0 and not DEFER:
        users = agent_users()
        if len(users) == 1:
            return handoff(users[0], code)
        if users:
            say("에이전트가 있는 계정이 여럿입니다: " + ", ".join(u.pw_name for u in users) + " — `sudo -iu <계정>`으로 바꾼 뒤 다시 실행해 주세요.",
                "Several accounts have agents: " + ", ".join(u.pw_name for u in users) + " — switch with `sudo -iu <user>` and run again."); return 3
    agents, clis = list_agents()
    if not agents:
        say("헤르메스·오픈클로 에이전트를 찾지 못했습니다. 게이트웨이를 실행하는 사용자 계정으로 다시 실행해 주세요.",
            "No Hermes or OpenClaw agents found. Run this again as the user that runs the gateway."); return 3
    tokens = {(a["kind"], a["id"]): "argo_bot_" + secrets.token_hex(24) for a in agents}
    host = re.sub(r"[^A-Za-z0-9.-]", "-", socket.gethostname()).strip("-.")[:253] or "server"
    report = [{"kind": a["kind"], "id": a["id"], "name": a["name"][:80], "default": a["default"],
               "token_hash": hashlib.sha256(tokens[(a["kind"], a["id"])].encode()).hexdigest(), "token_hint": tokens[(a["kind"], a["id"])][:12]} for a in agents]
    try:
        post("link/report", {"code": code, "host": host, "agents": report})
    except RuntimeError as e:
        say(f"연결 코드를 확인하지 못했습니다: {e}", f"Could not verify the connection code: {e}"); return 4
    for a in agents:
        print(f"  - {a['name']} ({a['kind']})")
    say(f"에이전트 {len(agents)}명을 찾았습니다. 이제 앱에서 연결할 에이전트를 확인하고 [연결]을 눌러 주세요. 이 창은 그대로 두세요.",
        f"Found {len(agents)} agent(s). Confirm them in the app and press Connect. Keep this window open.")
    deadline, picked = time.time() + WAIT_S, None
    while time.time() < deadline:
        try:
            st = post("link/status", {"code": code}).get("result") or {}
        except RuntimeError as e:
            say(f"연결이 만료되었거나 취소되었습니다: {e}", f"The connection expired or was cancelled: {e}"); return 5
        if st.get("status") in ("approved", "done"):
            picked = {(p.get("kind"), p.get("id")) for p in st.get("approved") or []}; break
        time.sleep(POLL_S)
    if picked is None:
        say("시간이 지나 연결을 멈췄습니다. 앱에서 명령을 새로 만들어 다시 실행해 주세요.", "Timed out. Create a new command in the app and run it again."); return 6
    chosen = [a for a in agents if (a["kind"], a["id"]) in picked]
    say(f"{len(chosen)}명을 연결합니다…", f"Connecting {len(chosen)} agent(s)…")
    results = []
    for a in [x for x in chosen if x["kind"] == "hermes"]:
        ok, out = install_hermes(clis["hermes"], a, tokens[("hermes", a["id"])])
        results.append({"kind": "hermes", "id": a["id"], "ok": ok, "detail": out[-300:], **({"unit": DEFERRED[a["id"]]} if a["id"] in DEFERRED else {})})
    oc = [x for x in chosen if x["kind"] == "openclaw"]
    if oc:
        for aid, (ok, out) in install_openclaw(clis["openclaw"], oc, {a["id"]: tokens[("openclaw", a["id"])] for a in oc}).items():
            results.append({"kind": "openclaw", "id": aid, "ok": ok, "detail": out[-300:]})
    names = {(a["kind"], a["id"]): a["name"] for a in agents}
    if DEFER:  # root 부모가 서비스를 재시작하고 결과를 보고한다
        with open(DEFER, "w", encoding="utf-8") as f:
            json.dump({"results": results, "names": {f"{k}:{i}": v for (k, i), v in names.items()}}, f)
        return 0
    return finish(code, results, names)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
