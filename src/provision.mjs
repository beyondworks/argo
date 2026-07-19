// 스캐폴드 프로비저닝 — "회사 = 폴더"의 표준 트리와 기본 설정을 어느 채널(웹·데스크톱·P1 워커)에서든 동일하게 보장한다.
// 멱등: .scaffold.json 버전 스탬프가 현재면 건너뛰고, 아니면 빠진 조각만 채운다. 기존 사용자 데이터는 절대 덮지 않는다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './workspace.mjs';

export const SCAFFOLD_VERSION = 2; // v2: inbox(받은 서류함 — 파일을 넣으면 크루가 처리)

// 크루가 스스로 폴더 규율을 지키게 하는 안내 노트 — 시스템 프롬프트(폴더 정리 규칙)와 같은 내용의 사람용 버전
const GUIDE = `---
title: Argo 폴더 사용법
---

# Argo 폴더 사용법 — 회사 기억이 사는 곳

이 회사의 모든 기억은 이 폴더 트리에 삽니다. 웹·데스크톱·텔레그램 어디서 일해도 같은 폴더를 봅니다.

- **vault/_index.md** — 기억의 현관. 크루는 새 작업 전 여기부터 읽습니다.
- **vault/journal/** — 대화·작업 일지(자동 기록).
- **vault/notes/** — 주제 노트. 재사용 가치가 있는 지식이 위키링크로 서로 이어집니다.
- **vault/files/** — 주고받은 첨부(이미지·문서).
- **vault/projects/** — 프로젝트성 산출물. 폴더명은 \`날짜_프로젝트명\` (예: \`20260711_뉴스레터-리뉴얼\`). 랜덤 영숫자 이름 금지.
- **inbox/** — 받은 서류함. 파일을 넣으면 기본 크루가 알아서 읽고 처리해 보고합니다(넣는 것이 곧 지시).
- **skills/** — 회사 스킬. 같은 일을 2번 하면 크루가 여기 규격을 남기고, 다음 턴부터 지침이 됩니다.
- **agents/** — 크루 카드(md가 곧 시스템 프롬프트 — 열어서 고칠 수 있습니다).
`;

/** 표준 스캐폴드 보장 — 생성·기동 어느 시점에 불려도 안전(멱등). 반환: 이번에 손봤는지 여부. */
export async function ensureScaffold(wsId) {
  const p = paths(wsId);
  const stamp = join(p.root, '.scaffold.json');
  try {
    if (JSON.parse(await readFile(stamp, 'utf8')).version >= SCAFFOLD_VERSION) return false;
  } catch { /* 스탬프 없음/손상 → 프로비저닝 진행 */ }
  for (const d of [p.agents, p.chats, p.skills, p.journal, p.notes, join(p.vault, 'files'), join(p.vault, 'projects'), join(p.root, 'inbox')]) {
    await mkdir(d, { recursive: true });
  }
  if (!existsSync(p.index)) await writeFile(p.index, '# 회사 기억 인덱스\n\n(아직 기록 없음)\n');
  // 기본 설정 — 능력은 전부 opt-in(끔)이 기본값. 파일이 있으면 사용자의 선택을 존중한다.
  if (!existsSync(p.capabilities)) {
    await writeFile(p.capabilities, JSON.stringify({ fs: false, browser: false, shell: false, bypass: false }, null, 2));
  }
  const guide = join(p.notes, 'argo-사용법.md');
  if (!existsSync(guide)) await writeFile(guide, GUIDE);
  await writeFile(stamp, JSON.stringify({ version: SCAFFOLD_VERSION, at: new Date().toISOString() }, null, 2));
  return true;
}

/** 서버 기동 시 전 회사 백필 — 웹이든 데스크톱이든 켜는 순간 표준 스캐폴드가 전역 설치된다. */
export async function ensureAllScaffolds() {
  const { listCompanies } = await import('./hub.mjs');
  const companies = await listCompanies().catch(() => []);
  let n = 0;
  for (const c of companies) {
    if (await ensureScaffold(c.id).catch(() => false)) n += 1;
  }
  if (n) console.log(`[argo] 스캐폴드 프로비저닝: ${n}개 회사 갱신 (v${SCAFFOLD_VERSION})`);
  return n;
}
