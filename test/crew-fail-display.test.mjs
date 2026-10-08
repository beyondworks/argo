// UX-A02(2026-10-05): '러너 없음' 실패 줄이 말줄임으로 잘려 다음 행동이 안 보이고, 영어 화면에도 한국어가 나왔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNoRunnerFailure, failCodeKey } from '../app/c/[ws]/crew/[slug]/fail-display.mjs';

test('러너 없음 실패(ko·en·제공 종료)를 알아보고, 다른 실패는 건드리지 않는다', () => {
  assert.equal(isNoRunnerFailure('AI 러너가 하나도 연결돼 있지 않습니다. 설정 → AI 연결에서 Claude·Codex 중 하나를 연결한 뒤 다시 말을 걸어 주세요.'), true);
  assert.equal(isNoRunnerFailure('No AI runner is connected. Connect one in Settings → AI connections (Claude, Codex), then try again.'), true);
  assert.equal(isNoRunnerFailure('연결된 러너는 더 이상 제공되지 않습니다. 설정 → …'), true);
  assert.equal(isNoRunnerFailure('The connected runner is no longer offered. Connect another runner …'), true);
  assert.equal(isNoRunnerFailure('rate limit exceeded'), false);
  assert.equal(isNoRunnerFailure(undefined), false);
});

// UL10(2026-10-05): 위 소스 문자열 단언("엔진 파일이 이 글자로 시작한다")은 엔진이 문장을 그대로 두고 조건만 바꿔도 초록이다.
// 실제 엔진(chat())을 러너가 없는 회사에서 돌려, 던져진 실패가 화면 판정(isNoRunnerFailure)에 알아봐지는지 행동으로 본다(ko·en 회사).
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

test('러너가 하나도 없는 회사에서 실제 chat()이 던지는 실패를 화면이 알아본다(ko·en) — 엔진이 문장을 바꾸면 여기서 드러난다', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-nrunner-'));
  const home = await mkdtemp(join(tmpdir(), 'argo-nrunner-home-'));
  Object.assign(process.env, { ARGO_ROOT: root, HOME: home, USERPROFILE: home, ARGO_ENC_VAULT: '0', ARGO_MODEL_CATALOG: 'off', ARGO_NATIVE_RUNNERS: 'off' });
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[key];
  const { createCompany, paths } = await import('../src/workspace.mjs');
  const { chat } = await import('../src/chat.mjs');
  const seen = [];
  for (const lang of ['ko', 'en']) {
    const ws = `nrunner-${lang}`;
    await createCompany(ws, '러너 없음 검증', 'owner', null, lang);
    await mkdir(paths(ws).agents, { recursive: true });
    await writeFile(join(paths(ws).agents, 'a.md'), '---\nname: 알파\nrole: 검증\n---\n페르소나.\n');
    let err;
    try { await chat(ws, 'a', '안녕'); } catch (e) { err = e; }
    assert.ok(err, `${lang}: 러너가 없으면 던진다`);
    assert.equal(isNoRunnerFailure(err.message), true, `${lang}: 화면이 알아보는 문장이어야 사전 문구·설정 링크로 바뀐다 — ${err.message.slice(0, 60)}`);
    seen.push(err.message);
  }
  assert.match(seen[0], /[가-힣]/); assert.doesNotMatch(seen[1], /[가-힣]/, 'en 회사는 영어 문장');
});

// 2026-10-09 검수 LOW: 실패 코드가 기기 사이에 동기화되면 옛 버전 화면은 사전에 없는 chat.fail.<새 코드>를 t()로 그려 키 글자를 그대로 보였다
// (context_exceeded·no_runner가 같은 모양). 이 버전부터는 사전에 없는 코드를 종전 원문 표시(chat.turnFailed)로 떨어뜨린다.
test('실패 코드 → 안내 키: 사전에 있는 코드만, 없는 코드(다른 기기의 새 버전)·unknown·빈 값은 null(원문 표시로)', async () => {
  const { readFileSync } = await import('node:fs');
  const { FAIL_CODES } = await import('../src/runners/error-class.mjs');
  const src = readFileSync(new URL('../app/i18n.jsx', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/^\s*'([^']+)':\s*\[/gm)].map((m) => m[1]));
  const has = (k) => keys.has(k);
  for (const code of FAIL_CODES.filter((c) => c !== 'unknown')) assert.equal(failCodeKey(code, has), `chat.fail.${code}`, `${code}: 이 버전 사전에 안내가 있다`);
  assert.equal(failCodeKey('context_exceeded', has), 'chat.fail.context_exceeded');
  assert.equal(failCodeKey('some_future_code', has), null, '사전에 없는 코드는 키 글자 대신 원문 표시로');
  assert.equal(failCodeKey('unknown', has), null);
  assert.equal(failCodeKey(null, has), null);
  assert.equal(failCodeKey(undefined, has), null);
  // 화면 배선 — page.jsx가 실패 줄의 문구와 줄 수 제한 둘 다 이 판정을 쓴다(템플릿 키 t(`chat.fail.${…}`)로 되돌리면 여기서 드러난다)
  const page = readFileSync(new URL('../app/c/[ws]/crew/[slug]/page.jsx', import.meta.url), 'utf8');
  assert.equal((page.match(/failCodeKey\(m\.failedCode, hasMsg\)/g) ?? []).length, 3);
  assert.doesNotMatch(page, /t\(`chat\.fail\.\$\{/);
  assert.match(src, /export const hasMsg = \(key\) => Object\.prototype\.hasOwnProperty\.call\(DICT, key\);/);
});
