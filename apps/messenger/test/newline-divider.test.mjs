// '새 메시지' 구분선 기준(D15) — 열 때의 읽음 커서를 글보다 먼저 고정한다.
// 글이 그려지면 읽음 표시(onRead)가 커서를 올린다. 그 뒤에 커서를 읽으면 다른 채널에 있을 때 온 글까지 읽은 것으로 보여 줄이 사라졌다.
// 실측(로컬 스택 두 계정): 수정 전 줄 없음, 수정 뒤 1건·3건 모두 첫 새 글 위에 줄.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('load — 읽음 커서는 글과 같이 읽고, 글을 상태에 넣기 전에 구분선을 고정한다', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = src.indexOf('const load = useCallback(async (afterId = 0) => {');
  const body = src.slice(start, src.indexOf('}, [chId, hydrate]);', start));
  assert.ok(start > 0 && body.length > 0, 'load를 찾는다');
  const reads = body.indexOf("from('msgr_reads')"), divider = body.indexOf('setDivider('), msgs = body.indexOf('setMsgs('), hydrate = body.indexOf('await hydrate(');
  assert.ok(reads > 0 && divider > 0 && msgs > 0 && hydrate > 0);
  assert.match(body, /await Promise\.all\(\[/, '글과 커서를 같이 읽는다(지연 추가 없음)');
  assert.ok(divider < msgs, '구분선이 글보다 먼저 — 글이 그려진 뒤의 읽음 표시가 끼어들 수 없다');
  assert.ok(reads < msgs && divider < hydrate, '커서 조회가 hydrate 뒤로 밀리지 않는다');
});
