// 메신저 연결 — connections.json. 봇 토큰은 워크스페이스 파일에만 두고(로그·API 응답 금지),
// 화면에는 항상 마스킹해서 내보낸다. SaaS(P1)에서는 서버측 암호화 보관으로 이전한다.
import { readFile, writeFile } from 'node:fs/promises';
import { paths } from './workspace.mjs';

const EMPTY = {
  telegram: { token: '', chatId: null, defaultCrew: '', enabled: false },
  slack: { token: '', channel: '', botUserId: null, defaultCrew: '', enabled: false },
};

export async function loadConnections(wsId) {
  try {
    const raw = JSON.parse(await readFile(paths(wsId).connections, 'utf8'));
    return { telegram: { ...EMPTY.telegram, ...raw.telegram }, slack: { ...EMPTY.slack, ...raw.slack } };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function updateConnection(wsId, kind, patch) {
  if (!['telegram', 'slack'].includes(kind)) throw new Error('알 수 없는 연결 종류');
  const all = await loadConnections(wsId);
  const next = { ...all[kind], ...patch };
  if (patch.token === '') next.token = all[kind].token; // 빈 토큰 = 기존 유지(토글만 바꿀 때)
  if (patch.token && patch.token !== all[kind].token) {
    next.chatId = null; // 토큰이 바뀌면 페어링 초기화
    next.botUserId = null;
  }
  all[kind] = next;
  await writeFile(paths(wsId).connections, JSON.stringify(all, null, 2));
  return all;
}

/** 화면용 — 토큰을 절대 그대로 내보내지 않는다. */
export function maskConnections(all) {
  const mask = (t) => (t ? `${t.slice(0, 5)}***${t.slice(-3)}` : '');
  return {
    telegram: { ...all.telegram, token: mask(all.telegram.token), hasToken: !!all.telegram.token },
    slack: { ...all.slack, token: mask(all.slack.token), hasToken: !!all.slack.token },
  };
}
