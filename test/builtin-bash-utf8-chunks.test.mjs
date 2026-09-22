// K65 — Bash 도구 출력이 청크 경계에서 한글(다바이트 UTF-8)을 깨뜨리지 않는다. 청크마다 문자열로 합치면 경계에 걸린 글자가 U+FFFD가 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const { builtinRunners } = await import('../src/engine/builtin-tools.mjs');
const POSIX = process.platform !== 'win32';

test('K65. 한 글자의 바이트가 두 청크로 나뉘어 와도(stdout·stderr 각각) 그대로 이어 붙는다', { skip: !POSIX && '/bin/sh printf 바이트 분할은 POSIX 전용' }, async () => {
  const t = builtinRunners({ cwd: tmpdir() });
  // '한' = ED 95 9C. 앞 두 바이트와 마지막 바이트 사이를 sleep으로 떼어 파이프 청크를 가른다.
  const out = await t.Bash({ command: "printf '\\355\\225'; sleep 0.3; printf '\\234글\\n'; printf '\\352\\270' 1>&2; sleep 0.3; printf '\\200\\n' 1>&2" });
  assert.ok(!out.includes('�'), `깨진 글자 없음: ${JSON.stringify(out)}`);
  assert.equal(out, '한글\n글\n');
});
