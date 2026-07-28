// 옵시디언 임포트 회귀 테스트 — 계약: ① 원본 볼트 무수정 ② 기존 데이터 불덮기(접미 번호)
// ③ 증류 불가는 미분류 보존+이유 ④ 위키링크는 임포트된 타깃으로 재작성, 모르는 타깃은 원문 보존
// ⑤ 재실행은 변화분만(manifest). 설계 정본: docs/obsidian-import-design.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes, symlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-obs-'));
process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-obshome-'));
const { classifyVaultEntry, sanitizeSegment, rewriteLinks, importObsidianVault, MAX_FILE_BYTES } = await import('../src/obsidian-import.mjs');

test('classifyVaultEntry: 설계 표의 분류 규칙', () => {
  assert.deepEqual(classifyVaultEntry('.obsidian/app.json'), { dest: 'skip', reason: 'config' });
  assert.deepEqual(classifyVaultEntry('a/.trash/x.md'), { dest: 'skip', reason: 'config' });
  assert.equal(classifyVaultEntry('templates/tpl.md').reason, 'template');
  assert.equal(classifyVaultEntry('서식/템플릿/틀.md').reason, 'template');
  assert.equal(classifyVaultEntry('2026-01-05.md').dest, 'journal');
  assert.equal(classifyVaultEntry('daily/2026-01-06 회의.md').dest, 'journal');
  assert.equal(classifyVaultEntry('Projects/계획.md').dest, 'notes');
  assert.equal(classifyVaultEntry('img/photo.PNG').dest, 'files');
  assert.equal(classifyVaultEntry('drawing.canvas').reason, 'unknown-type');
  assert.equal(classifyVaultEntry('big.pdf', MAX_FILE_BYTES + 1).reason, 'too-large');
});

test('sanitizeSegment: 위키링크·경로 위험 문자 제거, 한글·케이스 보존', () => {
  assert.equal(sanitizeSegment('프로젝트 계획'), '프로젝트-계획');
  assert.equal(sanitizeSegment('a/b\\c:d*e?f"g<h>i|j#k^l[m]n'), 'a-b-c-d-e-f-g-h-i-j-k-l-m-n');
  assert.equal(sanitizeSegment('  .hidden  '), 'hidden');
  assert.equal(sanitizeSegment('***'), 'untitled');
  assert.equal(sanitizeSegment('MixedCase v1.2'), 'MixedCase-v1.2');
});

test('rewriteLinks: 별칭·섹션은 타깃 유지에 흡수, 모르는 타깃은 원문 보존', () => {
  const noteMap = new Map([['계획', 'notes/계획'], ['2026-01-05', 'journal/2026-01-05-imported']]);
  const attMap = new Map([['img.png', 'files/imported/img.png'], ['doc.pdf', 'files/imported/doc.pdf']]);
  const out = rewriteLinks(
    '[[계획]] [[계획|별칭]] [[계획#섹션]] [[folder/계획]] [[2026-01-05]] ![[img.png]] [[doc.pdf]] [[없는노트]]',
    { noteMap, attMap, wsId: 'w1' },
  );
  assert.ok(out.includes('[[notes/계획]] [[notes/계획]] [[notes/계획]] [[notes/계획]]'), '별칭·섹션·폴더 경로 전부 새 rel로');
  assert.ok(out.includes('[[journal/2026-01-05-imported]]'));
  assert.ok(out.includes('![img.png](/api/companies/w1/files?rel=files%2Fimported%2Fimg.png)'), '이미지 임베드 → 인라인 렌더 URL');
  assert.ok(out.includes('[doc.pdf](/api/companies/w1/files?rel=files%2Fimported%2Fdoc.pdf)'), '비이미지 첨부 → 링크');
  assert.ok(out.includes('[[없는노트]]'), '미임포트 타깃은 원문 그대로');
});

async function makeSampleVault() {
  const src = await mkdtemp(join(tmpdir(), 'obs-vault-'));
  await mkdir(join(src, '.obsidian'), { recursive: true });
  await writeFile(join(src, '.obsidian', 'app.json'), '{}');
  await mkdir(join(src, 'daily'), { recursive: true });
  await mkdir(join(src, 'Projects'), { recursive: true });
  await mkdir(join(src, 'templates'), { recursive: true });
  await writeFile(join(src, '2026-01-05.md'), '# 일지\n[[프로젝트 계획]] 참고, ![[img.png]]\n');
  await writeFile(join(src, 'daily', '2026-01-06 회의.md'), '# 회의\n');
  await writeFile(join(src, 'Projects', '프로젝트 계획.md'), '# 계획\n[[2026-01-05]]와 [[없는노트]]\n');
  await writeFile(join(src, 'Projects', 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(src, 'templates', 'tpl.md'), '{{date}}\n');
  await writeFile(join(src, 'empty.md'), '   \n');
  await writeFile(join(src, 'drawing.canvas'), '{"nodes":[]}');
  await symlink('/etc/hosts', join(src, 'bad.md'));
  // 옛 노트의 mtime — 임포트가 시간을 보존하는지 본다
  const old = new Date('2024-03-01T09:00:00Z');
  await utimes(join(src, 'Projects', '프로젝트 계획.md'), old, old);
  return src;
}

async function makeCompany(ws) {
  const root = join(process.env.ARGO_ROOT, ws);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'company.json'), JSON.stringify({ id: ws, name: '테스트', lang: 'ko' }));
  return root;
}

test('importObsidianVault: 스캐폴드 재분류 + 링크 재작성 + 미분류 보존 + 리포트', async () => {
  const ws = 'imp-co';
  const root = await makeCompany(ws);
  const src = await makeSampleVault();
  const before = (await readdir(src)).length;

  const r = await importObsidianVault(ws, src);
  assert.equal(r.journal, 2, '데일리 노트 2건 → journal/');
  assert.equal(r.notes, 1);
  assert.equal(r.files, 1);
  assert.equal(r.unsorted, 3, '템플릿·빈 노트·canvas');
  assert.equal(r.skipped, 1, '심링크');
  assert.equal(r.configSkipped, 1, '.obsidian');

  // 배치 — vaultdoc.docKind가 일지로 인식하는 이름(YYYY-MM-DD-)
  const j1 = join(root, 'vault', 'journal', '2026-01-05-imported.md');
  const j2 = join(root, 'vault', 'journal', '2026-01-06-회의-imported.md');
  const n1 = join(root, 'vault', 'notes', '프로젝트-계획.md');
  assert.ok(existsSync(j1) && existsSync(j2) && existsSync(n1));
  assert.ok(existsSync(join(root, 'vault', 'files', 'imported', 'Projects', 'img.png')));

  // 링크 재작성 — 일지→노트, 노트→일지, 이미지 임베드, 모르는 타깃 보존
  const jText = await readFile(j1, 'utf8');
  assert.ok(jText.includes('[[notes/프로젝트-계획]]'), `일지 속 노트 링크: ${jText}`);
  assert.ok(jText.includes('/files?rel=files%2Fimported%2FProjects%2Fimg.png'), '이미지 임베드 → 서빙 URL');
  const nText = await readFile(n1, 'utf8');
  assert.ok(nText.includes('[[journal/2026-01-05-imported]]'));
  assert.ok(nText.includes('[[없는노트]]'), '미임포트 타깃 원문 보존');

  // 미분류 보존 + 이유
  assert.ok(existsSync(join(root, 'vault', '_imported', 'unsorted', 'templates', 'tpl.md')));
  assert.ok(existsSync(join(root, 'vault', '_imported', 'unsorted', 'empty.md')));
  assert.ok(existsSync(join(root, 'vault', '_imported', 'unsorted', 'drawing.canvas')));
  assert.deepEqual(new Set(r.unsortedItems.map((u) => u.reason)), new Set(['template', 'empty', 'unknown-type']));

  // 시간 보존 — 옛 노트가 "오늘 갱신"으로 둔갑하지 않는다
  const mt = (await stat(n1)).mtime.getTime();
  assert.equal(mt, new Date('2024-03-01T09:00:00Z').getTime(), '원본 mtime 복원');

  // 리포트 존재 + 원본 무수정
  assert.ok(r.reportRel && existsSync(join(root, r.reportRel)));
  assert.equal((await readdir(src)).length, before, '소스 볼트에 아무것도 안 생겼다');

  // 재실행 — 변화분 없음: 전부 already, 새 파일 0
  const notesBefore = (await readdir(join(root, 'vault', 'notes'))).length;
  const r2 = await importObsidianVault(ws, src);
  assert.equal(r2.already, 7, '배치됐던 7건(일지2·노트1·첨부1·미분류3) 전부 이미 가져옴');
  assert.equal(r2.journal + r2.notes + r2.files + r2.unsorted, 0);
  assert.equal((await readdir(join(root, 'vault', 'notes'))).length, notesBefore, '중복 사본 없음');

  // 소스 수정 후 재실행 — 기존을 덮지 않고 새 사본(접미 번호)
  await writeFile(join(src, 'Projects', '프로젝트 계획.md'), '# 계획 v2\n');
  const r3 = await importObsidianVault(ws, src);
  assert.equal(r3.notes, 1);
  assert.ok(existsSync(join(root, 'vault', 'notes', '프로젝트-계획-2.md')), '변경분은 -2로 분리 — 원본 노트 불덮기');
  assert.equal(await readFile(n1, 'utf8'), nText, '기존 노트 내용 그대로');
});

test('importObsidianVault: dryRun은 아무것도 쓰지 않는다', async () => {
  const ws = 'imp-dry';
  const root = await makeCompany(ws);
  const src = await makeSampleVault();
  const r = await importObsidianVault(ws, src, { dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.journal, 2);
  assert.equal(existsSync(join(root, 'vault', 'journal')), false, '드라이런은 폴더도 안 만든다');
  assert.equal(existsSync(join(root, 'vault', '_imported')), false);
  assert.equal(existsSync(join(root, '.import-status.json')), false, '상태 파일도 안 쓴다');
});

test('importObsidianVault: 보호 구역 소스·회사 부재 거부', async () => {
  await makeCompany('imp-guard');
  await assert.rejects(() => importObsidianVault('imp-guard', process.env.ARGO_ROOT), (e) => e.code === 'protected', '자기 데이터 루트 재귀 임포트 차단');
  await assert.rejects(() => importObsidianVault('imp-guard', '/no/such/vault'), (e) => e.code === 'not-found');
  const src = await mkdtemp(join(tmpdir(), 'obs-nows-'));
  await assert.rejects(() => importObsidianVault('no-such-ws', src), (e) => e.code === 'no-company');
});
