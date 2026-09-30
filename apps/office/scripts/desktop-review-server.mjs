import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, loadEnv } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.env.VERCEL_ENV === 'production') throw new Error('The review mail server cannot run in a production environment');
const source = loadEnv('development', process.env.OFFICE_REVIEW_ENV_DIR || root, 'VITE_');
const url = process.env.VITE_SUPABASE_URL || source.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY || source.VITE_SUPABASE_ANON_KEY;
if (!key || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('A loopback Supabase and public anon key are required');
const port = Number(process.env.OFFICE_REVIEW_PORT || 5192);
const fakePort = Number(process.env.OFFICE_FAKE_PORT || 58411);
const fakeOrigin = `http://127.0.0.1:${fakePort}`;
Object.assign(process.env, {
  VERCEL_ENV: 'development',
  VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: key,
  VITE_OFFICE_WEB_ORIGIN: `http://localhost:${port}`, VITE_OFFICE_REVIEW: '1', VITE_OFFICE_FAKE_GOOGLE_ORIGIN: fakeOrigin,
  OFFICE_ORIGIN: `http://localhost:${port}`,
  OFFICE_GOOGLE_CLIENT_ID: 'fake-client.apps.googleusercontent.com', OFFICE_GOOGLE_CLIENT_SECRET: 'fake-secret',
  OFFICE_MAIL_KEY: randomBytes(32).toString('base64'),
  OFFICE_GOOGLE_AUTH_URL: `${fakeOrigin}/auth`, OFFICE_GOOGLE_TOKEN_URL: `${fakeOrigin}/token`,
  OFFICE_GOOGLE_REVOKE_URL: `${fakeOrigin}/revoke`, OFFICE_GMAIL_API: `${fakeOrigin}/gmail/v1/users/me`,
});
const fake = spawn(process.execPath, [fileURLToPath(new URL('./e2e/fake-google.mjs', import.meta.url))], {
  env: { ...process.env, FAKE_GOOGLE_PORT: String(fakePort) }, stdio: ['ignore', 'pipe', 'inherit'],
});
fake.on('error', (e) => { console.error(e.message); process.exitCode = 1; });
await new Promise((resolve, reject) => {
  fake.stdout.once('data', resolve);
  fake.once('exit', () => reject(new Error('Fake mail provider could not start')));
});
const server = await createServer({ root, server: { host: 'localhost', port, strictPort: true } });
try { await server.listen(); } catch (e) { fake.kill(); throw e; }
console.log(`Office review API: http://localhost:${port}; synthetic mail: ${fakeOrigin}; no real Google account`);
const stop = async () => { fake.kill(); await server.close(); };
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
