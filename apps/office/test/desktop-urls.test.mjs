import test from 'node:test';
import assert from 'node:assert/strict';
import { webOrigin, webAddress, externalAddress } from '../src/core/desktop-urls.js';

test('desktop API and shared links use the configured web origin, never the asset origin', () => {
  const origin = webOrigin('https://office.example/');
  assert.equal(webAddress(origin, '/api/mail/read?account=a'), 'https://office.example/api/mail/read?account=a');
  assert.equal(webAddress(origin, '/s/abc'), 'https://office.example/s/abc');
  for (const path of ['//evil.example/x', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)']) assert.throws(() => webAddress(origin, path));
});

test('production origins require HTTPS; review HTTP accepts only loopback', () => {
  for (const value of ['', 'tauri://localhost', 'http://office.example', 'https://a:b@office.example', 'https://office.example/path', 'https://office.example/?key=x']) assert.throws(() => webOrigin(value));
  assert.equal(webOrigin('http://localhost:5192', { allowLocal: true }), 'http://localhost:5192');
  assert.throws(() => webOrigin('http://192.168.0.1:5192', { allowLocal: true }));
  assert.throws(() => webOrigin('http://localhost:5192'));
});

test('external links cannot execute scripts, access files or open arbitrary app schemes', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'argo-office://mail/callback', 'data:text/html,x', 'https://user:password@example.com']) assert.throws(() => externalAddress(value));
  for (const value of ['https://example.com/', 'mailto:hello@example.com', 'tel:+821012345678']) assert.equal(externalAddress(value), value);
});
