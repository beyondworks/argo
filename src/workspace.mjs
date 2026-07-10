// 워크스페이스 = 회사 1개의 격리 폴더 트리. SaaS에서는 유저별로 이 트리가 격리 컨테이너/볼륨에 산다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const WS_ROOT = process.env.ARGO_ROOT || process.env.CREWBASE_ROOT || join(process.cwd(), 'workspaces');

export function paths(wsId) {
  const root = join(WS_ROOT, wsId);
  return {
    root,
    company: join(root, 'company.json'),
    agents: join(root, 'agents'),
    chats: join(root, 'chats'),
    skills: join(root, 'skills'),
    vault: join(root, 'vault'),
    conversations: join(root, 'vault', 'conversations'),
    notes: join(root, 'vault', 'notes'),
    index: join(root, 'vault', '_index.md'),
  };
}

/** 회사 생성 — 가입 직후 1회. 폴더 트리 + company.json 시드. */
export async function createCompany(wsId, name, owner) {
  const p = paths(wsId);
  if (existsSync(p.company)) throw new Error(`이미 존재하는 회사: ${wsId}`);
  for (const d of [p.agents, p.skills, p.conversations, p.notes]) {
    await mkdir(d, { recursive: true });
  }
  const company = { id: wsId, name, owner, created: new Date().toISOString() };
  await writeFile(p.company, JSON.stringify(company, null, 2));
  await writeFile(p.index, `# ${name} — 회사 기억 인덱스\n\n(아직 기록 없음)\n`);
  return company;
}

export async function loadCompany(wsId) {
  return JSON.parse(await readFile(paths(wsId).company, 'utf8'));
}
