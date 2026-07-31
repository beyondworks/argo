// 작업 폴더 고정 — 실사용 신고(2026-07-31): 채팅에서 폴더를 고르면 그 지시 한 번만 반영되고
// 다음 턴엔 풀려서, 같은 폴더에서 이어 일하려면 매번 다시 지정해야 했다. 원인은 폴더 선택이
// **입력창 문구**였다는 것 — 보내면 사라지는 자리에 상태를 얹은 셈이다.
//
// 저장 위치는 `.workroots.json`의 pins다. 크루 카드(agents/*.md)가 아닌 이유: 카드는 기기 간
// **동기화되므로** 거기 두면 맥에서 고정한 바탕화면 경로가 윈도우로 넘어가 없는 폴더를 "지금 일할 곳"
// 으로 가리킨다(첫 구현이 실제로 그랬다). workroots는 그 이유로 이미 동기화에서 빠져 있고(sync.mjs
// EXCLUDE), 검증(validateWorkRoot)·잠금·도트파일 보호도 그대로 물려받는다.
//
// 여기서 잠그는 계약:
//  ① 고정은 등록된 폴더 중에서만 — 미등록 경로로 등록 검증을 우회하는 통로를 만들지 않는다.
//  ② 등록이 풀리거나 폴더가 사라지면 고정도 없는 것으로 친다(없는 경로를 우기지 않는다).
//  ③ **러너 중립성**(유건 지시): SDK든 CLI든 같은 출처에서 같은 문구를 받는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-pin-')); // import보다 먼저
const { loadPins, setPin, activePin, updateWorkRoots } = await import('../src/workroots.mjs');
const { commonDirectives } = await import('../src/chat.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'co-pin';
await createCompany(WS, '폴더고정 테스트사', 'captain');
// realpath로 잡는다 — 저장은 canonical(macOS는 /var → /private/var 심링크)이라 그러지 않으면
// 비교가 심링크 표기 대 실경로 표기로 어긋난다. 설정 UI도 목록의 canonical 값을 되돌려 보낸다.
const BASE = await realpath(await mkdtemp(join(tmpdir(), 'argo-pin-folders-')));
const FOLDER = join(BASE, '보고서');
const OTHER = join(BASE, '프로젝트');
await mkdir(FOLDER); await mkdir(OTHER);
await updateWorkRoots(WS, { add: FOLDER });
await updateWorkRoots(WS, { add: OTHER });

test('고정·해제 — 남고, 빈 값이 해제다', async () => {
  assert.equal(await setPin(WS, 'captain', FOLDER), FOLDER);
  assert.equal((await loadPins(WS)).captain, FOLDER, '디스크에 남아야 다음 턴에 산다');
  assert.equal(await activePin(WS, 'captain'), FOLDER);

  assert.equal(await setPin(WS, 'captain', ''), '', '빈 값 = 해제');
  assert.equal(await activePin(WS, 'captain'), '');
});

test('크루별로 따로 — 한 크루의 고정이 다른 크루를 건드리지 않는다', async () => {
  await setPin(WS, 'captain', FOLDER);
  await setPin(WS, 'mate', OTHER);
  assert.equal(await activePin(WS, 'captain'), FOLDER);
  assert.equal(await activePin(WS, 'mate'), OTHER);
  await setPin(WS, 'mate', '');
  assert.equal(await activePin(WS, 'captain'), FOLDER, '남의 해제가 내 고정을 지웠다');
});

test('등록된 폴더 중에서만 — 미등록 경로는 거부한다', async () => {
  const stray = join(BASE, '미등록');
  await mkdir(stray, { recursive: true });
  await assert.rejects(() => setPin(WS, 'captain', stray), (e) => e.code === 'not-registered',
    '미등록 폴더가 고정되면 등록 검증을 우회하는 통로가 된다');
  await assert.rejects(() => setPin(WS, 'captain', join(BASE, '없는폴더')), (e) => e.code === 'not-found');
});

test('등록이 풀리면 고정도 풀린다 — 부활하지 않는다', async () => {
  await setPin(WS, 'captain', FOLDER);
  await updateWorkRoots(WS, { remove: FOLDER });
  assert.equal(await activePin(WS, 'captain'), '', '등록에서 뺐는데 고정이 살아 있다');
  assert.equal((await loadPins(WS)).captain, undefined, '저장에도 남으면 재등록 때 조용히 부활한다');
  await updateWorkRoots(WS, { add: FOLDER }); // 원상 복구
});

test('폴더가 사라지면 없는 것으로 친다 — 없는 경로를 "지금 일할 곳"이라 우기지 않는다', async () => {
  const gone = join(BASE, '사라질폴더');
  await mkdir(gone, { recursive: true });
  await updateWorkRoots(WS, { add: gone });
  await setPin(WS, 'captain', gone);
  assert.equal(await activePin(WS, 'captain'), gone);
  await rm(gone, { recursive: true });                      // 외장 디스크 분리·폴더 삭제 상황
  assert.equal(await activePin(WS, 'captain'), '', '없는 폴더가 프롬프트에 들어간다');
  await updateWorkRoots(WS, { remove: gone });
  await setPin(WS, 'captain', FOLDER);
});

test('프롬프트 문구 — 고정이 있을 때만, ko·en 둘 다', () => {
  for (const lang of ['ko', 'en']) {
    const on = commonDirectives({ lang, pinnedFolder: FOLDER });
    assert.ok(on.includes(FOLDER), `${lang}: 고정 경로가 프롬프트에 없다`);
    const off = commonDirectives({ lang, pinnedFolder: '' });
    assert.ok(!off.includes(FOLDER), `${lang}: 고정이 없는데 경로가 새어 나왔다`);
  }
  // 등록 목록(가도 되는 곳)과 고정(지금 일할 곳)은 다른 문장이다 — 합치면 "가도 된다"로만 읽혀
  // 크루가 회사 폴더에 저장하고 만다. 둘 다 있을 때 두 경로가 모두 보여야 한다.
  const both = commonDirectives({ lang: 'ko', pinnedFolder: FOLDER, workRoots: [FOLDER, OTHER] });
  assert.ok(both.includes(FOLDER) && both.includes(OTHER));
  // 고정은 등록을 거쳐야 잡히므로 고정 폴더는 등록 목록에도 늘 들어 있다 — 두 줄이 같은 경로를
  // 반복하면 "지금 일할 곳"과 "그 밖에 써도 되는 곳"의 구분이 흐려진다. 등록 목록 쪽에서 뺀다.
  assert.equal(both.split(FOLDER).length - 1, 1, '고정 폴더가 두 번 언급된다');
});

test('러너 중립성 — SDK·CLI 어느 경로도 고정을 빠뜨리지 않는다(유건 지시: 편파 금지)', () => {
  // 문구가 옳아도 한 경로가 안 넘기면 그 러너 사용자만 매번 다시 지정하게 된다. chat()은 러너 자격이
  // 있어야 돌아 라이브로 못 재므로 배선을 소스에서 잠근다. **개수는 세지 않는다** — 세 번째 러너 경로가
  // 생기거나 두 호출을 하나로 합치는 정당한 리팩터가 개수 단언에 걸리면 그건 거짓 red다(반복 교훈).
  const src = readFileSync(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/commonDirectives\(\{[^}]*\}\)/g)].map((m) => m[0]);
  assert.ok(calls.length >= 2, `러너 경로가 2곳 미만이다 — 실제 ${calls.length}곳`);
  for (const call of calls) {
    // 축약 프로퍼티(`{ …, pinnedFolder }`)도 전달이다 — 콜론을 요구하면 정당한 표기에 거짓 red가 난다.
    assert.match(call, /\bpinnedFolder\b/, `이 호출이 고정을 안 넘긴다 — 러너 편파: ${call.slice(0, 80)}`);
  }
});
