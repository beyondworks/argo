import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { NextRequest } from 'next/server.js';
import { localBindProof, localAssetRequestDenied, localAssetPrincipalDenied, localAssetOwnerDenied, readLocalAssetJson } from '../src/local-asset-access.mjs';

const req = (headers = {}, method = 'GET') => new Request('http://127.0.0.1:3999/api/local-assets', { method, headers: { host: '127.0.0.1:3999', ...headers } });
const env = { ARGO_LOCAL_BIND_PROOF: '127.0.0.1' };
test('local startup evidence is required, tenant denies even AUTH off, forwarded host is ignored', () => {
  assert.equal(localAssetRequestDenied(req(), env), null);
  for (const config of [{}, { ARGO_HOST: '127.0.0.1' }, { ARGO_LOCAL_BIND_PROOF: '0.0.0.0' }, { ...env, ARGO_TENANT_OWNER: 'owner' }]) assert.equal(localAssetRequestDenied(req(), config), 'unavailable');
  assert.equal(localAssetRequestDenied(req({ host: 'remote.test', 'x-forwarded-host': 'localhost' }), env), 'unavailable');
});
test('reads and writes enforce exact origin and reject simple cross-site POST', () => {
  for (const method of ['GET', 'POST']) {
    const json = method === 'POST' ? { 'content-type': 'application/json' } : {};
    assert.equal(localAssetRequestDenied(req({ ...json, origin: 'http://127.0.0.1:3999' }, method), env), null);
    for (const headers of [{ origin: 'http://127.0.0.1:4000' }, { origin: 'null' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'tauri://localhost' }]) assert.equal(localAssetRequestDenied(req({ ...json, ...headers }, method), env), 'origin');
  }
  assert.equal(localAssetRequestDenied(req({ 'content-type': 'text/plain' }, 'POST'), env), 'invalid');
});
test('principal and company ownership never broaden from cookies or auth-off', () => {
  assert.equal(localAssetPrincipalDenied({ user: { id: 'a' }, deviceOwner: 'a', authOn: true }), null);
  for (const owner of ['b', undefined]) assert.equal(localAssetPrincipalDenied({ user: { id: 'a' }, deviceOwner: owner, authOn: true }), 'forbidden');
  assert.equal(localAssetPrincipalDenied({ user: null, authOn: true }), 'auth');
  assert.equal(localAssetPrincipalDenied({ user: { id: 'local' }, authOn: true }), 'forbidden');
  assert.equal(localAssetPrincipalDenied({ user: { id: 'local' }, authOn: true, guest: true }), null);
  assert.equal(localAssetPrincipalDenied({ user: { id: 'local' }, authOn: false }), null);
  assert.equal(localAssetPrincipalDenied({ user: { id: 'local' }, authOn: false, deviceOwner: 'a' }), 'forbidden');
  assert.equal(localAssetOwnerDenied('local', {}), null);
  assert.equal(localAssetOwnerDenied('local', { ownerId: 'a' }), 'forbidden');
  assert.equal(localAssetOwnerDenied('a', {}), 'forbidden');
  assert.equal(localAssetOwnerDenied('a', { ownerId: 'b' }), 'forbidden');
  assert.equal(localAssetOwnerDenied('a', { ownerId: 'a' }), null);
});

test('actual service install paths overwrite inherited proof and retain bind/port/restart contracts', async () => {
  const source = (await readFile(new URL('../scripts/service.mjs', import.meta.url), 'utf8')).replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '');
  for (const platform of ['darwin', 'linux', 'win32']) for (const host of ['127.0.0.1', '0.0.0.0']) {
    const files = new Map(), commands = [];
    const sandbox = {
      localBindProof, process: { platform, env: { ARGO_HOST: host, ARGO_PORT: '43210', ARGO_LOCAL_BIND_PROOF: 'inherited-invalid', USER: 'tester' }, execPath: '/node', argv: ['node', 'service', 'install'], getuid: () => 501, stdout: { write() {} }, exit: () => { throw new Error('unexpected exit'); } },
      dirname: (p) => p.slice(0, p.lastIndexOf('/')), join: (...p) => p.join('/'), fileURLToPath: () => '/repo/scripts/service.mjs', homedir: () => '/temporary-home',
      existsSync: (p) => p.endsWith('BUILD_ID'), mkdirSync() {}, rmSync() {}, readdirSync: () => [], readFileSync: p => p.endsWith('package.json') ? '{"version":"test-version"}' : 'test-build', writeFileSync: (p, data) => files.set(p, data),
      execFileSync: (file, args) => { commands.push([file, ...args].join(' ')); return ''; }, spawnSync: () => ({ status: 0 }), console: { log() {}, error() {} }, fetch: async () => ({ ok: true, json: async () => ({ argo: true, version: 'test-version', buildId: 'test-build' }) }), AbortSignal, setTimeout: (fn) => fn(),
    };
    await vm.runInNewContext(`(async () => { ${source.replaceAll('import.meta.url', "'file:///repo/scripts/service.mjs'")} })()`, sandbox);
    if (platform === 'linux') assert.ok(commands.indexOf('systemctl --user restart argo') > commands.indexOf('systemctl --user enable argo'));
    const generated = [...files.values()].join('\n');
    assert.ok(generated.includes(`start${platform === 'darwin' ? '</string><string>-H</string><string>' : ' -H '}${host}`));
    assert.ok(generated.includes('43210'));
    assert.ok(!generated.includes('inherited-invalid'));
    const proof = host === '127.0.0.1' ? host : '';
    const expected = platform === 'darwin' ? `<key>ARGO_LOCAL_BIND_PROOF</key><string>${proof}</string>` : `ARGO_LOCAL_BIND_PROOF=${proof}`;
    assert.ok(generated.includes(expected));
    assert.ok(generated.includes(platform === 'darwin' ? 'KeepAlive' : platform === 'linux' ? 'Restart=always' : 'goto loop'));
  }
});

async function moduleHarness(relative, dependencies, names) {
  const source = (await readFile(new URL(relative, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  return vm.runInNewContext(`(async () => { ${source}; return { ${names.join(',')} }; })()`, { Response, ...dependencies });
}

test('production auth adapter enforces gates before company/source IO and cannot adopt ownerless data', async () => {
  let reads = 0, guards = 0, devices = 0;
  let user = { id: 'local' }, owner, meta = {};
  const { localAssetAccess } = await moduleHarness('../app/local-assets-auth.mjs', {
    localAssetRequestDenied: (r) => localAssetRequestDenied(r, env), localAssetPrincipalDenied, localAssetOwnerDenied,
    AUTH_ON: false, currentUser: async () => user, loadDeviceSession: () => owner ? { user: { id: owner } } : null,
    guestModeOn: () => false, paths: () => ({ company: '/fake/company.json' }), readFile: async () => { reads++; return JSON.stringify(meta); },
    guardCompany: async () => { guards++; return null; }, getDeviceId: async () => { devices++; return 'device-1'; },
  }, ['localAssetAccess']);
  assert.ok((await localAssetAccess(req({ origin: 'https://evil.test' }), 'company')).response);
  assert.equal(reads, 0);
  assert.equal(devices, 0);
  owner = 'a';
  assert.ok((await localAssetAccess(req(), 'company')).response);
  assert.equal(reads, 0);
  user = { id: 'a' };
  assert.ok((await localAssetAccess(req(), 'company')).response);
  assert.equal(guards, 0, 'ownerless account cannot reach the auto-adopting generic guard');
  meta = { ownerId: 'a' };
  const allowed = await localAssetAccess(req(), 'company');
  assert.equal(allowed.context.principal, 'a');
  assert.equal(allowed.context.device, 'device-1');
  assert.equal(guards, 1);
  assert.equal(devices, 1);
});

test('actual route handlers gate every operation before source IO, reject extra options and redact exceptions', async () => {
  for (const relative of ['../app/api/local-assets/route.js', '../app/api/companies/[ws]/local-assets/route.js']) {
    let denied = true, calls = 0, bodyReads = 0;
    const operation = async () => { calls++; throw new Error('/private/source secret command'); };
    const { GET, POST } = await moduleHarness(relative, {
      readLocalAssetJson: async (request) => { bodyReads++; return readLocalAssetJson(request); },
      localAssetAccess: async () => denied ? { response: Response.json({ uiKey: 'denied' }, { status: 403 }) } : { context: { principal: 'local', device: 'd' } },
      localAssetFailure: (_error, fallback = 'internal') => Response.json({ uiKey: `localImport.error.${fallback}` }, { status: fallback === 'internal' ? 500 : 400 }),
      localAssetError: (reason, status = 403) => Response.json({ uiKey: `localImport.error.${reason}` }, { status }), localAssetResponse: Response.json,
      discoverLocalAssets: operation, deferLocalAssets: operation, localAssetStatus: operation, previewLocalAssets: operation, executeLocalAssets: operation,
    }, ['GET', 'POST']);
    const params = { params: Promise.resolve({ ws: 'company' }) };
    const post = (body) => new Request('http://127.0.0.1:3999/api/local-assets', { method: 'POST', headers: { host: '127.0.0.1:3999', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await GET(req(), params)).status, 403);
    assert.equal((await POST(post({ action: 'import' }), params)).status, 403);
    assert.equal(calls, 0);
    assert.equal(bodyReads, 0, 'denied context never consumes request body');
    denied = false;
    const oversized = post({ action: 'preview', padding: 'x'.repeat(256 * 1024) });
    assert.equal((await POST(oversized, params)).status, 400);
    assert.equal(calls, 0, 'oversized JSON cannot reach source operation');
    assert.equal((await POST(post({ action: relative.includes('companies') ? 'preview' : 'defer', home: '/private/source' }), params)).status, 400);
    assert.equal(calls, 0);
    const error = await GET(req(), params);
    assert.deepEqual(await error.json(), { uiKey: 'localImport.error.internal' });
    assert.equal(calls, 1);
  }
});


test('error adapter allows only finite core codes and never exception text', async () => {
  const { localAssetFailure } = await moduleHarness('../app/local-assets-auth.mjs', {}, ['localAssetFailure']);
  assert.deepEqual(await localAssetFailure({ reason: 'scan-expired' }).json(), { uiKey: 'localImport.error.scan-expired' });
  assert.deepEqual(await localAssetFailure({ reason: '/private/path CANARY', message: 'secret' }).json(), { uiKey: 'localImport.error.internal' });
});


test('JSON input is bounded by actual bytes, cancels overflow, and rejects invalid UTF-8/JSON', async () => {
  assert.deepEqual(await readLocalAssetJson(new Request('http://localhost', { method: 'POST', body: '{"action":"defer"}' })), { action: 'defer' });
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readLocalAssetJson({ body, headers: new Headers({ 'content-length': '1' }) }), /body-too-large/);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  await assert.rejects(readLocalAssetJson(new Request('http://localhost', { method: 'POST', body: new Uint8Array([255]) })));
  await assert.rejects(readLocalAssetJson(new Request('http://localhost', { method: 'POST', body: '{' })));
  await assert.rejects(readLocalAssetJson({ body: null }));
});


test('actual NextRequest loopback normalization preserves strict raw Host origin checks', () => {
  for (const host of ['127.0.0.1:3999', 'localhost:3999', '[::1]:3999']) {
    for (const method of ['GET', 'POST']) {
      const request = (origin, extra = {}) => new NextRequest(`http://${host}/api/local-assets`, {
        method, headers: { host, ...(origin ? { origin } : {}), 'content-type': 'application/json', ...extra },
      });
      assert.equal(new URL(request().url).hostname, 'localhost', 'real NextRequest normalizes loopback hosts');
      assert.equal(localAssetRequestDenied(request(`http://${host}`), env), null);
      assert.equal(localAssetRequestDenied(request(), env), null);
      for (const other of ['127.0.0.1:3999', 'localhost:3999', '[::1]:3999'].filter(h => h !== host)) {
        assert.equal(localAssetRequestDenied(request(`http://${other}`), env), 'origin');
      }
      for (const origin of ['https://evil.test', `http://${host.replace('3999', '4000')}`, `https://${host}`, 'null']) {
        assert.equal(localAssetRequestDenied(request(origin), env), 'origin');
      }
      assert.equal(localAssetRequestDenied(request(`http://${host}`, { 'sec-fetch-site': 'cross-site' }), env), 'origin');
    }
  }
});
