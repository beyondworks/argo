# Argo

[![Latest release](https://img.shields.io/github/v/release/beyondworks/argo-agent?label=release&color=b8860b)](https://github.com/beyondworks/argo-agent/releases/latest)

> **The AI agent company that remembers everything.** One prompt hires a team of
> specialist AI agents; they share a folder-based long-term memory and finish work
> together — on your machine, with your own model accounts.
>
> Named after the *Argo* — the ship that carried heroes of different crafts on one
> voyage for the Golden Fleece.

- **Website / download**: [argo.ceo](https://argo.ceo) · **Releases**: [beyondworks/argo-agent](https://github.com/beyondworks/argo-agent/releases/latest)

## What makes it different

- **Folder-scale memory** — every conversation, note and artifact lands in a per-company
  vault (`journal/`, `notes/`, `projects/`) with wiki-style `[[links]]`. Memory is files
  you own, not a black box.
- **Local-first** — runners, memory and orchestration all run on your machine.
  The cloud (Supabase Auth + Storage + RLS) is used for **one thing only**: syncing your
  memory across devices when you sign in. Sync payloads support envelope encryption.
- **Bring your own runner** — connect any of five engines with your own account:
  Claude (Agent SDK / subscription OAuth), Codex, Gemini, GLM, Kimi. No middleman keys.
- **A team of agents, not a chatbot** — agents message each other (`to/cc`, inbox, delegation),
  compete on drafts, hold meeting-room discussions, and run scheduled routines.
- **Leave your desk, keep the thread** — hand off any conversation to Telegram/Slack;
  your PC stays the leader device.

## Install

**Desktop app (recommended)** — [argo.ceo](https://argo.ceo) or grab the
[latest release](https://github.com/beyondworks/argo-agent/releases/latest)
(macOS Apple Silicon dmg, signed & notarized · Windows installer).

**One line (Linux x86_64 server / CLI):**

```bash
curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash
```

Installs the latest server build under `~/.argo-selfhost` and registers the `argo`
command (`~/.local/bin/argo`). Sign in with `argo`, then `argo service install` to keep it
running. `--local` installs the loopback-only local web server instead. Re-run the same
command to update. Details & security defaults: [docs/selfhost.md](docs/selfhost.md).

**Terminal-only `argo` on macOS · Windows (from v0.1.97):** no desktop app needed — the asset
bundles its own Node.js and is checked against a SHA-256 file before install.

```bash
# macOS (Apple Silicon · Intel) — installs to ~/.argo-selfhost/app and ~/.local/bin/argo
curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash
```

```powershell
# Windows (PowerShell, x64) — installs to %LOCALAPPDATA%\argo-cli and adds it to your user PATH
irm https://github.com/beyondworks/argo-agent/releases/latest/download/install.ps1 | iex
```

Re-run to update; `argo uninstall` removes the program (your data in `~/.argo` stays). If the
desktop app is installed, use its `argo` instead — on macOS register it in **Settings → Devices &
data**, on Windows the app installer registers it (installing the app later replaces the
standalone command so both use the same data).

## Run from source

```bash
npm install
npm run dev        # web UI → http://localhost:3000
```

- Runner credentials are entered in **Settings → AI connections** (validated before save)
  or via env (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, …). Nothing is stored in
  plaintext outside your data root.
- Data root defaults to `workspaces/` (override with `ARGO_ROOT`). It is gitignored —
  user data never enters the repo.

### Always-on service (optional)

```bash
npm run service install    # start now + auto-start at login, self-restart within 10s
npm run service status
npm run service logs
npm run service uninstall
```

macOS launchd / Linux systemd user unit (+linger) / Windows Task Scheduler — all
user-level, no sudo. With the service up, the Telegram/Slack gateway and routine
scheduler run without the UI open (`ARGO_PORT` to change the default 3999).

## Adding a device

**Sign-in = sync (default).** Install Argo on the new device and sign in with the same
account — companies (memory, agents, conversations, bot tokens and runner credentials)
come down automatically. Credentials cross the cloud only as account-key envelope
ciphertext; sessions live in a `0600` device file; storage is locked per-owner by RLS.

**Link code (self-host backup path).** Only for auth-less self-hosted setups:
Settings → Devices → **Create link code** on the old device, paste on the new one.
Treat the code like a password.

## Docs

| Doc | What it covers |
|---|---|
| [docs/selfhost.md](docs/selfhost.md) | Linux VPS / CLI install, security defaults, headless runner connect |
| [docs/privacy-sync.md](docs/privacy-sync.md) | What syncs to the cloud (credentials included), where the encryption key lives, and how to opt out |
| [SECURITY.md](SECURITY.md) | Trust model — what the permission gate actually guarantees, what it cannot (shell, prompt injection, external CLI runners), and how to report |

## License

**Source-available, not open source** — see [LICENSE.md](LICENSE.md).
You may read the code and run it unmodified (including self-hosting for your own
account). Modifying, redistributing, or offering it as a service requires written
consent from beyondworks.

---

## 한국어

프롬프트 한 줄로 전문 AI 에이전트를 영입하고, 회사가 **폴더 단위 기억**으로 일하는 개인용
AI 회사입니다. 러너·기억·오케스트레이션은 전부 로컬에서 돌고, 클라우드(Supabase)는
**로그인 시 기기 간 기억 동기화에만** 쓰입니다.

- 다운로드: [argo.ceo](https://argo.ceo) (맥 실리콘 dmg 서명·공증 / Windows 설치본)
- 터미널 한 줄 설치: 리눅스 x86_64·맥은 위 `install.sh` 명령, 윈도우는 PowerShell `irm …/install.ps1 | iex`(맥·윈도우는 v0.1.97부터, node 포함·해시 확인). 업데이트는 다시 실행, 제거는 `argo uninstall`(데이터는 남김). 데스크톱 앱이 있으면 앱의 `argo`를 쓴다(맥은 설정 → 기기·데이터에서 등록, 윈도우는 설치 프로그램이 등록)
- 러너 연결은 설정 → AI 연결에서 본인 계정으로(BYOK — Claude·Codex·Gemini·GLM·Kimi)
- 셀프호스트 보안 기본값·헤드리스 연결: [docs/selfhost.md](docs/selfhost.md)
- 클라우드 동기화 범위(자격 증명 포함)·암호화 열쇠 위치·끄는 방법: [docs/privacy-sync.md](docs/privacy-sync.md)
- 신뢰 모델 — 권한 게이트가 보장하는 것과 못 막는 것(셸·프롬프트 인젝션·외부 CLI 러너), 제보 방법: [SECURITY.md](SECURITY.md)
