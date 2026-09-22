// 본체 전수 검수(2026-09-22) G1 — 러너 상태·안내 결함 K14·K37·K38·K39 행동 잠금.
//  K14 codex는 2026-08-21부터 danger-full-access(샌드박스 없음) — "홈·작업 폴더 밖이라 막혔다"는 틀린 처방.
//      경로 추출이 공백에서 끊겨(C:\Users\John Doe) 홈 판정이 뒤집힌다. 서술형 안내는 macOS 경로만 줬다.
//  K37 autoRunnerOf가 회사 기본 러너를 안 봐 크루 카드의 자동 러너가 실제 턴(resolveRunner)과 갈린다.
//  K38 /api/runners가 상태 조회 실패를 삼켜 전 러너를 '연결 필요'로 그렸다 — 호출자가 실패를 알 수 있어야 한다.
//  K39 시운전 실패 안내가 제공 중단 방식·무효 자격도 "AI 연결이 아직 안 되어 있어요"로 뭉쳤다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { mkdtemp } from './helpers/tmp.mjs';

// 실데이터·실 CLI 미접촉 — 홈·루트·PATH를 임포트 전에 격리한다.
const ROOT = await mkdtemp(join(tmpdir(), 'argo-g1-root-'));
const HOME = await mkdtemp(join(tmpdir(), 'argo-g1-home-'));
process.env.ARGO_ROOT = ROOT;
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.SHELL = '/usr/bin/true'; // ensureCliPath의 로그인 셸 PATH 캡처 무력화
process.env.ARGO_CACHE_DIR = await mkdtemp(join(tmpdir(), 'argo-g1-cache-'));
delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; // 인증 끔(로컬 게스트)

// 가짜 codex — --output-last-message 파일에 샌드박스 거부 생 에러 줄을 답으로 쓴다(실측 형태, runner-denial 헤더).
const BIN = join(ROOT, 'bin');
await mkdir(BIN, { recursive: true });
await writeFile(join(BIN, 'codex'), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
OUT=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then OUT="$a"; fi
  prev="$a"
done
[ -n "$OUT" ] && printf 'zsh:1: operation not permitted: /Volumes/USB/a.txt' > "$OUT"
exit 0
`);
await chmod(join(BIN, 'codex'), 0o755);
process.env.PATH = `${BIN}:/usr/bin:/bin`;
process.env.ARGO_CODEX_PREFER_PATH = '1';

const mkws = async (ws, company = {}) => {
  for (const d of [['agents'], ['chats'], ['vault', 'journal'], ['vault', 'projects'], ['vault', 'files'], ['vault', 'notes']]) {
    await mkdir(join(ROOT, ws, ...d), { recursive: true });
  }
  await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws, name: 'T', owner: 'me', lang: 'ko', created: new Date().toISOString(), ...company }));
  await writeFile(join(ROOT, ws, 'agents', 'crew-a.md'), '---\nname: 크루A\n---\n\n전문가.\n');
};
const secrets = (ws, runners) => writeFile(join(ROOT, ws, '.secrets.json'), JSON.stringify({ runners }));

const { detectRunnerDenial, denialNote } = await import('../src/runner-denial.mjs');
const { chat } = await import('../src/chat.mjs');
const { runnerStatus, autoRunnerOf } = await import('../src/runners.mjs');
const { runTrialTurn } = await import('../src/trial.mjs');
const { loadThread } = await import('../src/thread.mjs');

const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v || Date.now() - t0 > ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
};

/* ── K14 ── */
test('K14 codex 턴의 샌드박스 밖 경로 거부 — "작업 폴더 등록" 처방을 붙이지 않는다(codex는 쓰기 범위가 없다)',
  { skip: process.platform === 'win32' ? 'POSIX 셸 가짜 codex' : false }, async () => {
  const WS = 'g1-codex';
  await mkws(WS);
  await writeFile(join(ROOT, WS, 'agents', 'crew-a.md'), '---\nname: 크루A\nrunner: codex\n---\n\n전문가.\n');
  await secrets(WS, { codex: { type: 'apikey', value: 'sk-fake-not-a-real-key' } });
  const r = await chat(WS, 'crew-a', '보고서를 USB에 저장해줘');
  assert.match(r.reply, /쓰기가 막혔습니다/, '거부 안내 자체는 붙는다(인접 행동)');
  assert.doesNotMatch(r.reply, /작업 폴더/, 'codex는 danger-full-access — 작업 폴더 등록은 해법이 아니다');
  assert.match(r.reply, /시스템 설정|AI 연결/, 'OS 권한·러너 재연결 후보로 안내');
});

test('K14 gemini(작업 폴더 반경이 남은 러너)의 홈 밖 거부는 여전히 작업 폴더 등록을 안내한다(인접 행동)', () => {
  const note = denialNote({ cap: 'fs', path: '/Volumes/USB/a.txt', lang: 'ko', outsideHome: true, runner: 'gemini' });
  assert.match(note, /설정 → 작업 폴더/);
});

test('K14 서술형 안내 — codex엔 작업 폴더 갈래가 없고, OS 안내는 macOS·Windows 둘 다 준다', () => {
  const co = denialNote({ cap: 'fs', lang: 'ko', narration: true, runner: 'codex' });
  assert.doesNotMatch(co, /작업 폴더/);
  for (const lang of ['ko', 'en']) {
    for (const runner of ['codex', 'gemini', 'antigravity']) {
      const s = denialNote({ cap: 'fs', lang, narration: true, runner });
      assert.match(s, lang === 'en' ? /Windows/ : /윈도우/, `${lang}/${runner}: Windows 안내 누락`);
      assert.match(s, lang === 'en' ? /Privacy & Security/ : /개인정보 보호 및 보안/, `${lang}/${runner}: macOS 안내 누락`);
    }
  }
  assert.match(denialNote({ cap: 'fs', lang: 'ko', narration: true, runner: 'gemini' }), /작업 폴더/, 'gemini는 범위 갈래 유지');
});

test('K14 경로 추출 — 공백이 든 경로(C:\\Users\\John Doe, /Users/John Doe)를 자르지 않는다', () => {
  assert.equal(detectRunnerDenial("Error: EPERM: operation not permitted, open 'C:\\Users\\John Doe\\a.txt'")?.path, 'C:\\Users\\John Doe\\a.txt');
  assert.equal(detectRunnerDenial('zsh:1: operation not permitted: /Users/John Doe/Documents/a.txt')?.path, '/Users/John Doe/Documents/a.txt');
  // 인접 — 경로 뒤 문장은 경로에 먹히지 않는다
  assert.equal(detectRunnerDenial('cp: /Volumes/USB/a.txt: Read-only file system')?.path, '/Volumes/USB/a.txt');
  assert.equal(detectRunnerDenial('zsh:1: operation not permitted: /Users/kim/a.txt while saving')?.path, '/Users/kim/a.txt');
});

/* ── K37 ── */
test('K37 autoRunnerOf — 회사 기본 러너를 넘기면 턴(resolveRunner)과 같은 러너를 고른다', async () => {
  const WS = 'g1-default';
  await mkws(WS, { defaultRunner: 'kimi' });
  await secrets(WS, { glm: { type: 'apikey', value: 'test-glm-key' }, kimi: { type: 'apikey', value: 'test-kimi-key' } });
  const st = await runnerStatus(WS);
  assert.equal(autoRunnerOf(st), 'glm', '인접: 기본 러너 없으면 정의 순');
  assert.equal(autoRunnerOf(st, 'kimi'), 'kimi', '기본 러너(kimi)를 무시하고 정의 순(glm)을 집으면 카드가 턴과 갈린다');
});

test('K37·K38 /api/runners 실호출 — autoRunnerId는 회사 기본 러너 반영, 상태 조회 실패는 statusError로 알린다', async () => {
  register(new URL('./helpers/next-esm-resolve.mjs', import.meta.url));
  const route = await import('../app/api/runners/route.js');
  const WS = 'g1-default'; // 위 테스트의 회사(glm+kimi, 기본 kimi)
  const ok = await (await route.GET(new Request(`http://localhost/api/runners?ws=${WS}`))).json();
  assert.equal(ok.autoRunnerId, 'kimi');
  assert.ok(!ok.statusError, '정상 조회엔 실패 표지가 없다');
  const BAD = 'g1-broken';
  await mkws(BAD);
  await writeFile(join(ROOT, BAD, '.secrets.json'), '{ not json');
  const bad = await (await route.GET(new Request(`http://localhost/api/runners?ws=${BAD}`))).json();
  assert.equal(bad.statusError, true, '조회 실패를 삼키면 화면은 전 러너 "연결 필요"로 거짓 표기한다');
  assert.ok(Array.isArray(bad.runners), '카탈로그 목록은 그대로 내려준다(셀렉터가 비지 않게)');
});

/* ── K39 ── */
const trialReply = async (ws) => {
  runTrialTurn(ws, 'crew-a');
  const t = await waitFor(async () => (await loadThread(ws, 'crew-a').catch(() => null))?.messages?.find((m) => m.who !== 'user'));
  return t?.text ?? t?.reply ?? JSON.stringify(t);
};

test('K39 시운전 — 저장 자격의 방식이 제공 중단이면 그 사실(재연결 방법)을 ko/en으로 안내한다', async () => {
  const WS = 'g1-trial-unsup';
  await mkws(WS);
  await secrets(WS, { glm: { type: 'oauth', value: 'legacy-oauth-token' } }); // glm은 API 키 전용 — oauth는 제공 중단 방식
  const reply = await trialReply(WS);
  assert.doesNotMatch(reply, /AI 연결이 아직 안 되어 있어요/, '연결해 둔 사용자에게 "연결 안 됨"은 거짓');
  assert.match(reply, /더 이상 제공되지 않습니다/);
  assert.match(reply, /no longer offered/);
});

test('K39 시운전 — 연결된 자격이 무효(로그아웃된 이 컴퓨터 로그인)면 재연결을 안내한다', async () => {
  const WS = 'g1-trial-invalid';
  await mkws(WS);
  await secrets(WS, { codex: { type: 'host', value: 'host' } }); // 격리 HOME엔 codex 로그인이 없다 → invalid
  const reply = await trialReply(WS);
  assert.doesNotMatch(reply, /AI 연결이 아직 안 되어 있어요/);
  assert.match(reply, /다시 연결/);
  assert.match(reply, /reconnect/i);
});

test('K39 시운전 — 정말 아무것도 연결 안 됐으면 기존 "연결 안 됨" 안내(인접 행동)', async () => {
  const WS = 'g1-trial-none';
  await mkws(WS);
  const reply = await trialReply(WS);
  assert.match(reply, /AI 연결이 아직 안 되어 있어요/);
  assert.match(reply, /AI isn't connected yet/);
});
