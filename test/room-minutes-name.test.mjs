// 회의록 파일명 충돌 — 같은 분(HHMM) 안에 "회의 마치기"를 두 번 하면 앞 회의록이 덮이던 결함(격리 실측 2026-09-02).
// 회의록은 vault/journal 일지 = 회사 기억이라 유실이 곧 기억 유실. 접미(-2, -3) + 배타 생성(wx)으로 잠근다.
// 시각은 주입 불가(endMeetingLocked가 new Date())라, 분 경계를 넘긴 시도는 버리고 같은 분 안에서 다시 잰다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-minutes-name-'));
const { endMeeting } = await import('../src/room.mjs');
const { paths } = await import('../src/workspace.mjs');
const { docKind } = await import('../src/vaultdoc.mjs');

const two = (n) => String(n).padStart(2, '0');
const stemNow = () => { const d = new Date(); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-회의록-${two(d.getHours())}${two(d.getMinutes())}`; };
async function seedRoom(ws, topic) {
  const p = paths(ws);
  await mkdir(p.chats, { recursive: true }); await mkdir(join(p.root, 'agents'), { recursive: true }); await mkdir(p.journal, { recursive: true });
  await writeFile(join(p.root, 'company.json'), JSON.stringify({ name: ws, lang: 'ko' }));
  await writeFile(join(p.root, 'agents', 'beast.md'), '---\nname: 비스트\nrole: 마케팅\n---\n');
  await writeFile(join(p.chats, 'room-main.json'), JSON.stringify({ sid: 1, messages: [{ who: 'user', text: topic, ts: Date.now() }, { who: 'beast', text: `${topic} 답변`, ts: Date.now() }] }));
}
/** 같은 분 안에서 fn을 완주할 때까지 재시도(분 경계 플레이크 차단). 반환: fn의 결과 */
async function withinOneMinute(fn) {
  for (let i = 0; i < 5; i += 1) {
    const before = stemNow(); const out = await fn(before);
    if (stemNow() === before) return out;
  }
  throw new Error('같은 분 안에서 5회 실패 — 시계가 비정상');
}

test('같은 분 안에 두 번 마치면 회의록이 두 개 남고 각각의 내용이 보존된다(덮어쓰기 금지)', async () => {
  const ws = 'mn-two';
  const { r1, r2 } = await withinOneMinute(async () => {
    await rm(paths(ws).journal, { recursive: true, force: true });
    await seedRoom(ws, '첫 회의 안건'); const r1 = await endMeeting(ws);
    await new Promise((res) => setTimeout(res, 10)); // mtime이 확실히 뒤가 되게(인덱스 순서 단언용)
    await seedRoom(ws, '둘째 회의 안건'); const r2 = await endMeeting(ws);
    return { r1, r2 };
  });
  assert.ok(r1.archived && r2.archived);
  assert.notEqual(r1.journal, r2.journal, '두 번째 이름이 첫 번째와 달라야 한다(같은 분이라 -2 접미)');
  assert.match(r2.journal, /-\d{4}-2\.md$/, '접미 규칙 = 주제 노트·옵시디언 임포트와 동일(-2)');
  const dir = paths(ws).journal;
  const names = (await readdir(dir)).sort();
  assert.equal(names.length, 2, `회의록 2개: ${names}`);
  const [a, b] = await Promise.all([readFile(join(dir, r1.journal.replace(/^journal\//, '')), 'utf8'), readFile(join(dir, r2.journal.replace(/^journal\//, '')), 'utf8')]);
  assert.match(a, /첫 회의 안건/); assert.doesNotMatch(a, /둘째 회의 안건/, '첫 회의록이 뒤 회의로 덮이면 안 된다');
  assert.match(b, /둘째 회의 안건/);
  // 인덱스 "최근 일지"는 최신(뒤 회의 = -2)이 위 — 파일명 역순이면 base → -2 순으로 뒤집힌다(검수 LOW-1 실측)
  const idx = (await readFile(paths(ws).index, 'utf8')).split('\n');
  const at = (rel) => idx.findIndex((l) => l.includes(`[[${rel.replace(/\.md$/, '')}]]`));
  assert.ok(at(r1.journal) > 0 && at(r2.journal) > 0, '두 회의록 모두 인덱스에 등재');
  assert.ok(at(r2.journal) < at(r1.journal), `뒤 회의(-2)가 위: ${idx.filter((l) => l.includes('회의록')).join(' | ')}`);
});

test('journal 폴더에 쓸 수 없으면(EACCES) 매달리지 않고 그 오류를 던진다 — 삼키면 무한 루프 + 회의실 락 영구 보유', { skip: process.platform === 'win32' ? 'chmod 의미 다름' : process.getuid?.() === 0 ? 'root는 권한 무시' : false }, async () => {
  const ws = 'mn-eacces';
  await seedRoom(ws, '권한 없는 폴더');
  await chmod(paths(ws).journal, 0o555);
  try {
    const hang = new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 5000).unref());
    await assert.rejects(Promise.race([endMeeting(ws), hang]), (e) => e?.code === 'EACCES', 'EACCES를 그대로 — HANG이면 가드가 빠진 것');
  } finally { await chmod(paths(ws).journal, 0o755); }
});

test('이미 -2까지 있으면 -3 — 비어 있는 첫 이름을 잡는다', async () => {
  const ws = 'mn-three';
  const { stem, r } = await withinOneMinute(async (stem) => {
    await seedRoom(ws, '셋째 회의');
    await rm(paths(ws).journal, { recursive: true, force: true }); await mkdir(paths(ws).journal, { recursive: true });
    await writeFile(join(paths(ws).journal, `${stem}.md`), '기존 1'); await writeFile(join(paths(ws).journal, `${stem}-2.md`), '기존 2');
    return { stem, r: await endMeeting(ws) };
  });
  assert.equal(r.journal, `journal/${stem}-3.md`);
  assert.equal(await readFile(join(paths(ws).journal, `${stem}.md`), 'utf8'), '기존 1', '기존 파일 무손상');
  assert.equal(await readFile(join(paths(ws).journal, `${stem}-2.md`), 'utf8'), '기존 2');
});

test('접미가 붙어도 인덱스·주간 롤업이 일지로 분류한다(docKind) — 날짜 접두가 기준', () => {
  assert.equal(docKind('journal/2026-09-02-회의록-1953.md'), 'journal');
  assert.equal(docKind('journal/2026-09-02-회의록-1953-2.md'), 'journal');
  assert.equal(docKind('journal/2026-09-02-회의록-1953-12.md'), 'journal');
});
