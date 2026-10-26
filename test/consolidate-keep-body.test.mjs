// 기억 정리가 주제 노트 본문을 덮어 옛 결론이 사라지던 결함(2026-10-26 총괄 감사 축 B) — 임시 ARGO_ROOT + 가짜 원샷. 실 러너 호출 0.
// 재현: 주제 노트 13개 중 가장 오래된 노트(발췌 12개 밖)를 같은 제목으로 갱신하면 saveNote(merge)가 본문을 통째로 바꿔 옛 결론이 사라졌다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-consol-keep-'));
process.env.ARGO_SYNC = '0';
const { consolidateMemory, _setOneShotForTest } = await import('../src/consolidate.mjs');
const { paths } = await import('../src/workspace.mjs');

const OLD = '중요결론: 환불은 7일 이내에만 받는다(결제일 기준).';
const NEW = '결제 수단에 카드를 추가하기로 했다.';
const note = (title, body) => `---\nupdated: 2026-09-01\n---\n# ${title}\n\n${body}\n`;

async function seed({ oldBody = OLD, extra = 12 } = {}) {
  const ws = `keep-${Math.random().toString(36).slice(2, 8)}`; const p = paths(ws);
  await mkdir(p.journal, { recursive: true }); await mkdir(p.notes, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ id: ws, name: 'Keep', lang: 'ko' }));
  await writeFile(join(p.notes, '결제-정책.md'), note('결제 정책', oldBody));
  await utimes(join(p.notes, '결제-정책.md'), new Date('2026-01-01'), new Date('2026-01-01')); // 가장 오래된 노트 — 최근 12개 발췌 밖
  for (let i = 0; i < extra; i++) await writeFile(join(p.notes, `주제-${i}.md`), note(`주제 ${i}`, `주제 ${i}의 결론.`));
  await writeFile(join(p.journal, '2026-10-26-pepper.md'), `## 10:00\n${'결제 수단 회의: 카드 결제를 추가하자는 결론. '.repeat(30)}\n`);
  return { ws, p };
}
const body = async (p) => readFile(join(p.notes, '결제-정책.md'), 'utf8');
const history = async (p) => { try { return (await readdir(join(p.notes, '.history'))).filter((n) => n.endsWith('.md')); } catch { return []; } };

// 가짜 모델: 정리 프롬프트에는 같은 제목에 새 내용만 낸다(옛 본문을 보지 못한 모델의 전형). 합치기 프롬프트에는 받은 기존·새 본문을 둘 다 담아 낸다.
const fake = (calls, { mergeOut = null } = {}) => async (_ws, prompt) => {
  calls.push(prompt);
  if (/\[기존 본문\]|\[existing body\]/.test(prompt)) {
    if (mergeOut !== null) return { runner: 'claude', text: mergeOut, usage: {}, costUsd: 0 };
    const notes = [...prompt.matchAll(/### (.+)\n\[기존 본문\]\n([\s\S]*?)\n\[새 본문\]\n([\s\S]*?)(?=\n### |\n*$)/g)]
      .map(([, title, old, fresh]) => ({ title, content: `${old.trim()}\n${fresh.trim()}` }));
    return { runner: 'claude', text: JSON.stringify({ notes }), usage: {}, costUsd: 0 };
  }
  return { runner: 'claude', text: JSON.stringify({ notes: [{ title: '결제 정책', content: NEW }] }), usage: {}, costUsd: 0 };
};

test('발췌 밖(가장 오래된) 노트를 같은 제목으로 갱신해도 옛 결론이 본문에 남는다 — 합치기 호출이 기존 본문 전체를 받는다', async () => {
  const { ws, p } = await seed();
  const calls = [];
  _setOneShotForTest(fake(calls));
  await consolidateMemory(ws);
  const now = await body(p);
  assert.ok(now.includes(OLD), `옛 결론이 남아야 한다:\n${now}`);
  assert.ok(now.includes(NEW), '새 결론도 들어간다');
  assert.equal(calls.length, 2, '정리 1회 + 합치기 1회');
  assert.ok(calls[1].includes(OLD), '합치기 프롬프트에 기존 본문 전체가 들어간다');
});

test('덮기 전 옛 본문 사본이 vault/notes/.history/에 남는다(인덱스·색인은 한 단계만 읽어 섞이지 않는다)', async () => {
  const { ws, p } = await seed();
  _setOneShotForTest(fake([]));
  await consolidateMemory(ws);
  const h = await history(p);
  assert.equal(h.length, 1, `사본 1개: ${h}`);
  assert.match(h[0], /^결제-정책\.\d{8}-\d{6}(?:-\d+)?\.md$/);
  assert.ok((await readFile(join(p.notes, '.history', h[0]), 'utf8')).includes(OLD), '사본은 옛 본문 그대로');
  const index = await readFile(join(p.vault, '_index.md'), 'utf8');
  assert.doesNotMatch(index, /\.history/, '인덱스에 사본이 실리지 않는다');
});

test('합치기 호출이 실패해도(형식 오류) 옛 결론을 잃지 않는다 — 옛 본문을 "이전 정리" 절로 붙여 둔다', async () => {
  const { ws, p } = await seed();
  _setOneShotForTest(fake([], { mergeOut: 'not json' }));
  await consolidateMemory(ws);
  const now = await body(p);
  assert.ok(now.includes(OLD) && now.includes(NEW), now);
  assert.equal((await history(p)).length, 1);
});

test('본문 전체가 발췌로 보인 노트는 합치기 호출 없이 모델 출력을 그대로 쓴다(비용 증가 없음), 본문이 같으면 사본도 없다', async () => {
  const { ws, p } = await seed({ extra: 0 }); // 노트 1개 = 발췌 안, 800자 이내
  const calls = [];
  _setOneShotForTest(async (_ws, prompt) => { calls.push(prompt); return { runner: 'claude', text: JSON.stringify({ notes: [{ title: '결제 정책', content: `${OLD}\n${NEW}` }] }), usage: {}, costUsd: 0 }; });
  await consolidateMemory(ws);
  assert.equal(calls.length, 1, '합치기 호출 없음');
  assert.ok((await body(p)).includes(OLD));
  assert.equal((await history(p)).length, 1, '본문이 바뀌었으니 사본 1개');
  // 같은 본문으로 한 번 더(새 일지) → 본문 변화 없음 → 사본 추가 없음
  await writeFile(join(p.journal, '2026-10-27-pepper.md'), `## 10:00\n${'같은 결론을 다시 확인. '.repeat(40)}\n`);
  await consolidateMemory(ws);
  assert.equal((await history(p)).length, 1, '본문이 같으면 사본을 만들지 않는다');
  assert.ok(!existsSync(join(p.notes, '.history', '.history')));
});

test('사본 폴더의 동기화·색인 취급 — 동기화는 일반 파일(다른 기기에도 사본), 기억 색인·인덱스는 notes/ 한 단계만 읽어 사본을 싣지 않는다', async () => {
  const { EXCLUDE } = await import('../src/sync.mjs');
  // 구조적 제외(기기 로컬 폴더) 없이 일반 노트와 같은 취급 — 암호 키가 없으면 둘 다 그 사이클 불가시, 있으면 둘 다 암호문으로 올라간다
  assert.equal(EXCLUDE('vault/notes/.history/결제-정책.20261026-221500.md'), EXCLUDE('vault/notes/결제-정책.md'), '사본은 일반 노트와 같은 동기화 취급');
  const { ws, p } = await seed();
  _setOneShotForTest(fake([]));
  await consolidateMemory(ws);
  const { loadDocsMeta } = await import('../src/memindex.mjs');
  const docs = (await loadDocsMeta(ws)) ?? [];
  assert.ok(!docs.some((d) => d.rel.includes('.history')), '기억 색인에 사본 없음');
  assert.equal((await history(p)).length, 1);
});

test('파일 이름과 제목이 다른 노트(create의 -2 접미)가 발췌에 보여도, 보이지 않은 같은 제목 노트는 합치기를 거친다(분리 검수 M1)', async () => {
  const { ws, p } = await seed({ extra: 0 });
  // 결제-정책-2.md(제목 "결제 정책", 짧은 본문)는 발췌에 전부 보이고, 결제-정책.md는 800자를 넘어 잘린다
  await writeFile(join(p.notes, '결제-정책.md'), note('결제 정책', `${OLD}\n${'세부 조항. '.repeat(120)}`));
  await writeFile(join(p.notes, '결제-정책-2.md'), note('결제 정책', '다른 기기에서 만든 같은 제목 노트.'));
  const calls = [];
  _setOneShotForTest(fake(calls));
  await consolidateMemory(ws);
  assert.equal(calls.length, 2, '합치기 호출이 있어야 한다');
  assert.ok((await body(p)).includes(OLD));
});

test('같은 날 같은 노트를 여러 번 덮어도 사본은 하루 1개(그날 처음 덮기 직전 상태)', async () => {
  const { ws, p } = await seed();
  _setOneShotForTest(fake([]));
  await consolidateMemory(ws);
  for (let i = 0; i < 3; i++) {
    await writeFile(join(p.journal, `2026-10-2${7 + i}-pepper.md`), `## 10:00\n${`추가 결론 ${i}. `.repeat(60)}\n`);
    _setOneShotForTest(async () => ({ runner: 'claude', text: JSON.stringify({ notes: [{ title: '결제 정책', content: `${OLD}\n${NEW}\n추가 ${i}` }] }), usage: {}, costUsd: 0 }));
    await consolidateMemory(ws);
  }
  const h = await history(p);
  assert.equal(h.length, 1, `하루 1개: ${h}`);
  assert.ok((await readFile(join(p.notes, '.history', h[0]), 'utf8')).includes(OLD) && !(await readFile(join(p.notes, '.history', h[0]), 'utf8')).includes(NEW), '그날 처음 덮기 직전 = 원래 본문');
});
