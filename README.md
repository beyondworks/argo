# Argo

> **The AI agent company that remembers everything.** One prompt hires a crew of
> specialist AI agents; they share a folder-based long-term memory and finish work
> together — on your machine, with your own model accounts.
>
> Named after the *Argo* — the ship that carried heroes of different crafts on one
> voyage for the Golden Fleece.

- **Website / download**: [argo.ceo](https://argo.ceo) · **Releases**: [beyondworks/argo-agent](https://github.com/beyondworks/argo-agent/releases/latest)
- **Product spec**: [PRODUCT-SPEC.md](PRODUCT-SPEC.md) · **Current design**: [docs/local-first-design.md](docs/local-first-design.md)

## What makes it different

- **Folder-scale memory** — every conversation, note and artifact lands in a per-company
  vault (`journal/`, `notes/`, `projects/`) with wiki-style `[[links]]`. Memory is files
  you own, not a black box.
- **Local-first** — runners, memory and orchestration all run on your machine.
  The cloud (Supabase Auth + Storage + RLS) is used for **one thing only**: syncing your
  memory across devices when you sign in. Sync payloads support envelope encryption.
- **Bring your own runner** — connect any of five engines with your own account:
  Claude (Agent SDK / subscription OAuth), Codex, Gemini, GLM, Kimi. No middleman keys.
- **A crew, not a chatbot** — agents message each other (`to/cc`, inbox, delegation),
  compete on drafts, hold meeting-room discussions, and run scheduled routines.
- **Leave your desk, keep the thread** — hand off any conversation to Telegram/Slack;
  your PC stays the leader device.

## Install

**Desktop app (recommended)** — [argo.ceo](https://argo.ceo) or grab the
[latest release](https://github.com/beyondworks/argo-agent/releases/latest)
(macOS Apple Silicon dmg, signed & notarized · Windows installer).

**One line (macOS · Linux, self-host/CLI track):**

```bash
curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash
```

Installs the latest server build under `~/.argo-selfhost`, binds to loopback
(`127.0.0.1:3001`), and registers a self-healing user service. Re-run the same
command to update. Details & security defaults: [docs/selfhost.md](docs/selfhost.md).

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
account — companies (memory, crew, conversations, bot tokens and runner credentials)
come down automatically. Credentials cross the cloud only as account-key envelope
ciphertext; sessions live in a `0600` device file; storage is locked per-owner by RLS.

**Link code (self-host backup path).** Only for auth-less self-hosted setups:
Settings → Devices → **Create link code** on the old device, paste on the new one.
Treat the code like a password.

## Docs

| Doc | What it covers |
|---|---|
| [docs/local-first-design.md](docs/local-first-design.md) | **Current canonical design** — local-first + slim cloud sync |
| [docs/selfhost.md](docs/selfhost.md) | Linux VPS / CLI install, security defaults, headless runner connect |
| [docs/security-encryption-roadmap.md](docs/security-encryption-roadmap.md) | Memory envelope-encryption roadmap |
| [docs/cloud-hybrid-design.md](docs/cloud-hybrid-design.md) | Superseded — kept for a future 24/7 cloud-worker scope |
| [docs/deploy-fly.md](docs/deploy-fly.md) | Superseded — cloud worker is out of the current scope |
| [PRODUCT-SPEC.md](PRODUCT-SPEC.md) | Product vision, pricing anchor, milestones |

## License

No license yet — all rights reserved for now (source visible, redistribution not granted).
A proper license decision is tracked for an upcoming release.

---

## 한국어

프롬프트 한 줄로 전문 AI 크루를 영입하고, 회사가 **폴더 단위 기억**으로 일하는 개인용
AI 회사입니다. 러너·기억·오케스트레이션은 전부 로컬에서 돌고, 클라우드(Supabase)는
**로그인 시 기기 간 기억 동기화에만** 쓰입니다.

- 다운로드: [argo.ceo](https://argo.ceo) (맥 실리콘 dmg 서명·공증 / Windows 설치본)
- 터미널 한 줄 설치(맥·리눅스 셀프호스트): 위 [Install](#install) 명령 그대로
- 러너 연결은 설정 → AI 연결에서 본인 계정으로(BYOK — Claude·Codex·Gemini·GLM·Kimi)
- 셀프호스트 보안 기본값·헤드리스 연결: [docs/selfhost.md](docs/selfhost.md)
