import { guardCompany } from '../../../../../auth.mjs';
import { routineNotificationOptions } from '../../../../../../src/routine-notifications.mjs';

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  try {
    return Response.json(await routineNotificationOptions(ws, new URL(req.url).searchParams.get('agentSlug')));
  } catch {
    return Response.json({ error: 'Notification destinations unavailable', channels: [], messengerChannels: [] }, { status: 503 });
  }
}
