// Codex식 터미널 패널 API. 원격/호스팅에서는 절대 열지 않고 localhost의 회사 소유자 + shell 능력만 허용한다.
import { loadCapabilities } from '../../../../../src/capabilities.mjs';
import { resolveWorkspaceToolRoot } from '../../../../../src/workspace-tools.mjs';
import {
  closeToolTerminal,
  interruptToolTerminal,
  readToolTerminal,
  startToolTerminal,
  writeToolTerminal,
} from '../../../../../src/tool-terminal.mjs';
import { csrfDenied, guardCompany, isLoopbackHost } from '../../../../auth.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function gate(req, ws, { mutate = false } = {}) {
  if (process.env.ARGO_TENANT_OWNER?.trim() || !isLoopbackHost(req.headers.get('host'))) {
    return Response.json({ error: 'terminal-local-only' }, { status: 403 });
  }
  if (mutate) {
    const csrf = csrfDenied(req); if (csrf) return csrf;
  }
  const denied = await guardCompany(ws); if (denied) return denied;
  const caps = await loadCapabilities(ws);
  if (!caps.shell) return Response.json({ error: 'terminal-shell-disabled' }, { status: 403 });
  return null;
}

const fail = (error) => Response.json(
  { error: error?.code || 'terminal-error' },
  { status: error?.status || 400 },
);

export async function GET(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await gate(req, ws); if (denied) return denied;
    const url = new URL(req.url);
    return Response.json(readToolTerminal({
      wsId: ws,
      id: url.searchParams.get('id') || '',
      cursor: url.searchParams.get('cursor') || 0,
    }));
  } catch (error) {
    return fail(error);
  }
}
export async function POST(req, { params }) {
  try {
    const { ws } = await params;
    const denied = await gate(req, ws, { mutate: true }); if (denied) return denied;
    const body = await req.json();
    if (body.action === 'start') {
      const root = await resolveWorkspaceToolRoot(ws, body.root || 'company');
      return Response.json(startToolTerminal({ wsId: ws, cwd: root.root }));
    }
    if (body.action === 'input') return Response.json(writeToolTerminal({ wsId: ws, id: body.id, input: body.input }));
    if (body.action === 'interrupt') return Response.json(interruptToolTerminal({ wsId: ws, id: body.id }));
    if (body.action === 'close') return Response.json(closeToolTerminal({ wsId: ws, id: body.id }));
    return Response.json({ error: 'terminal-unknown-action' }, { status: 400 });
  } catch (error) {
    return fail(error);
  }
}
