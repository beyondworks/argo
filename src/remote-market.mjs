// 원격 마켓 연동 — skillsmp.com(스킬)·공식 MCP 레지스트리(도구)를 검색하고 즉시 설치한다.
// 링크 이동 없음: 스킬은 GitHub raw에서 md를 받아 skills/에, MCP는 mcp.json에 바로 심는다.
// 외부 실패 시 조용히 빈 결과 + 오류 메시지(내장 카탈로그는 항상 동작).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './workspace.mjs';
import { loadMcp } from './market.mjs';

const TTL = 10 * 60 * 1000;
const cache = new Map(); // key → {at, data}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const data = await fn();
  cache.set(key, { at: Date.now(), data });
  return data;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'argo-market/0.1' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`원격 응답 ${res.status}`);
  return res.json();
}

/* ─── 스킬: skillsmp.com ─── */
export async function searchRemoteSkills(q) {
  return cached(`sk:${q}`, async () => {
    const d = await fetchJson(`https://skillsmp.com/api/skills?search=${encodeURIComponent(q)}`);
    return (d.skills ?? []).slice(0, 12).map((s) => ({
      id: s.id,
      name: s.name,
      author: s.author,
      desc: (s.description ?? '').slice(0, 160),
      stars: s.stars ?? 0,
      githubUrl: s.githubUrl,
    }));
  });
}

/** GitHub tree/blob URL → raw SKILL.md 후보들. */
function rawCandidates(githubUrl) {
  const m = String(githubUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(tree|blob)\/([^/]+)\/(.+)$/);
  if (!m) {
    const root = String(githubUrl).match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/);
    if (root) return ['main', 'master'].map((b) => `https://raw.githubusercontent.com/${root[1]}/${root[2]}/${b}/SKILL.md`);
    return [];
  }
  const [, owner, repo, kind, branch, path] = m;
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  if (kind === 'blob' || path.endsWith('.md')) return [`${base}/${path}`];
  return [`${base}/${path}/SKILL.md`, `${base}/${path}.md`, `${base}/${path}/README.md`];
}

export async function installRemoteSkill(wsId, { name, githubUrl }) {
  const safe = String(name ?? '').toLowerCase().replace(/[^a-z0-9가-힣-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!safe) throw new Error('스킬 이름이 없습니다');
  let md = null;
  for (const url of rawCandidates(githubUrl)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 200_000) throw new Error('스킬 파일이 너무 큽니다(200KB 초과)');
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) continue;
      md = `<!-- source: ${githubUrl} -->\n\n${text}`;
      break;
    } catch { /* 다음 후보 */ }
  }
  if (!md) throw new Error('SKILL.md를 찾지 못했습니다 — 저장소 구조가 표준과 다릅니다');
  await mkdir(paths(wsId).skills, { recursive: true });
  await writeFile(join(paths(wsId).skills, `${safe}.md`), md);
  return { id: safe };
}

/* ─── MCP: 공식 레지스트리 ─── */
export async function searchRemoteMcp(q) {
  return cached(`mcp:${q}`, async () => {
    const d = await fetchJson(`https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(q)}&limit=30`);
    const seen = new Set();
    const out = [];
    for (const item of d.servers ?? []) {
      const sv = item.server ?? {};
      if (seen.has(sv.name)) continue;
      seen.add(sv.name);
      // 즉시 설치 가능한 형태만: npm 패키지(→ npx stdio) 또는 streamable-http 원격
      const npm = (sv.packages ?? []).find((p) => p.registryType === 'npm');
      const remote = (sv.remotes ?? []).find((r) => r.type === 'streamable-http');
      if (!npm && !remote) continue;
      out.push({
        name: sv.name,
        title: sv.title || sv.name.split('/').pop(),
        desc: (sv.description ?? '').slice(0, 160),
        install: npm ? { kind: 'npm', pkg: npm.identifier } : { kind: 'http', url: remote.url },
      });
      if (out.length >= 12) break;
    }
    return out;
  });
}

export async function installRemoteMcp(wsId, { name, install }) {
  const safe = String(name ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!safe) throw new Error('MCP 이름이 없습니다');
  let def;
  if (install?.kind === 'npm' && install.pkg) {
    def = { command: 'npx', args: ['-y', install.pkg] };
  } else if (install?.kind === 'http' && /^https:\/\//.test(install.url ?? '')) {
    def = { type: 'http', url: install.url };
  } else {
    throw new Error('설치 가능한 배포 형태(npm/http)가 아닙니다');
  }
  const cfg = await loadMcp(wsId);
  cfg.servers[safe] = def;
  await writeFile(paths(wsId).mcp, JSON.stringify(cfg, null, 2));
  return { name: safe };
}
