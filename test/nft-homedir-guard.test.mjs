// Next 추적기(nft) 홈 글롭 방지 — node:os 홈·임시 폴더 함수를 동적 join 첫 인자나 map되는 배열에 넣으면 nft가 빌드타임에 실평가해
// 홈 전체를 글롭하고, Windows 릴리스 빌드가 러너 홈의 WindowsApps 별칭(EACCES)에서 죽는다(v0.1.30·v0.1.35·v0.1.94 CI 실측).
// 맥 빌드에서는 재현되지 않으므로(홈이 프로젝트와 같은 드라이브라 추적 무시 규칙에 걸린다) 소스 규칙으로 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // .pathname은 윈도우에서 /D:/… 꼴이 되어 D:\D:\…로 풀린다
function files(dir) {
  const out = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) out.push(...files(p));
    else if (/\.(mjs|js|jsx)$/.test(n)) out.push(p);
  }
  return out;
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
// 동적 join: homedir()/tmpdir() 다음 인자가 문자열 리터럴이 아니다(slice·변수·템플릿 첫 칸 등)
const DYN_JOIN = /join\(\s*(?:os\.)?(?:homedir|tmpdir)\(\)\s*,\s*(?=[^\s'"])/;
// map되는 배열의 맨 원소로 놓인 homedir()/tmpdir() — 각 원소를 resolve하면 홈 루트 자체가 동적 경로가 된다.
// join(homedir(), '.argo')처럼 상수로 이어 붙인 원소는 그 폴더만 훑어 관용된다(0.1.93까지 무사).
const IN_MAPPED_ARRAY = /[\[,]\s*(?:os\.)?(?:homedir|tmpdir)\(\)\s*[,\]][^;\n]*\.(?:map|flatMap)\(/;

test('src·app·instrumentation에 nft 홈 글롭을 부르는 homedir()/tmpdir() 패턴이 없다', () => {
  const bad = [];
  for (const f of [...files('src'), ...files('app'), 'instrumentation.mjs', 'instrumentation-node.mjs']) {
    let s; try { s = strip(readFileSync(join(ROOT, f), 'utf8')); } catch { continue; }
    s.split('\n').forEach((line, i) => { if (DYN_JOIN.test(line) || IN_MAPPED_ARRAY.test(line)) bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(bad, [], `homedir()/tmpdir()는 env(HOME·USERPROFILE·TMPDIR·TEMP)로 바꾸세요:\n${bad.join('\n')}`);
});

test('규칙이 실제로 잡는다 — 이번 사고 꼴과 예전 사고 꼴', () => {
  assert.ok(DYN_JOIN.test("return join(homedir(), d.slice(1));"));
  assert.ok(IN_MAPPED_ARRAY.test("const R = [...new Set([homedir(), WS_ROOT, tmpdir(), '/tmp'].filter(Boolean).map((r) => resolve(r)))];"));
  assert.ok(!DYN_JOIN.test("join(homedir(), '.argo', 'tools')"), '상수 join은 그 폴더만 훑어 관용(v0.1.34까지 무사)');
  assert.ok(!IN_MAPPED_ARRAY.test("[WS_ROOT, join(homedir(), '.argo')].map(canon)"), '상수 join 원소는 관용');
});
