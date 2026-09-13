// Scheduling only publishes an authorized channel command. Existing Messenger workers
// retain execution ownership, approval checks and result delivery.
export async function dispatchMessengerAutomations(client, wsId) {
  const { data, error } = await client.rpc('msgr_automation_dispatch_due', { p_ws: wsId });
  // Rolling upgrades: an older database must not stop ordinary message delivery.
  if (error?.code === 'PGRST202' || error?.code === '42883') return { available: false, runs: [] };
  if (error) throw new Error(`msgr automation: ${error.message}`);
  return { available: true, runs: Array.isArray(data) ? data : [] };
}
