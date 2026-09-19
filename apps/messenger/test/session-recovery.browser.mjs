import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.D56_BASE_URL || 'http://127.0.0.1:5216';
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const page = await browser.newPage({ locale: 'ko-KR' });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(base);
  await page.getByRole('heading', { name: '연결을 기다리는 중' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '다시 로그인' }).isVisible(), true);
  assert.equal(await page.getByText('Google로 계속하기').count(), 0, 'retryable failure must not show Auth');

  await page.evaluate(() => window.__d56.recover());
  await page.getByText('Fixture General', { exact: true }).waitFor();

  await page.evaluate(() => window.__d56.signedOut());
  await page.getByText(/로그인이 끝났습니다/).waitFor();
  assert.equal(await page.getByText('Google로 계속하기').isVisible(), true, 'SIGNED_OUT must use the existing D10 Auth path');

  await page.goto(`${base}/?race=signedout`);
  await page.getByText('Google로 계속하기').waitFor();
  assert.equal(await page.getByText('Fixture General', { exact: true }).count(), 0, 'stale initial read must not undo SIGNED_OUT');

  await page.goto(`${base}/?race=new`);
  await page.getByRole('heading', { name: '아직 조직이 없습니다.' }).waitFor();
  assert.equal(await page.getByText('Fixture General', { exact: true }).count(), 0, 'stale old identity must not replace a newer session');

  await page.goto(`${base}/?race=relogin`);
  await page.getByText('Google로 계속하기').waitFor();
  assert.equal(await page.getByText('Fixture General', { exact: true }).count(), 0, 'stale initial read must not undo explicit re-login');

  await page.goto(`${base}/?signout=fail`);
  await page.getByRole('heading', { name: '연결을 기다리는 중' }).waitFor();
  await page.getByRole('button', { name: '다시 로그인' }).click();
  await page.getByText(/로그인 정보를 정리하지 못했습니다/).waitFor();
  assert.equal(await page.getByRole('heading', { name: '연결을 기다리는 중' }).isVisible(), true, 'failed cleanup must remain fail-closed');
  assert.equal(await page.evaluate(() => window.__d56.stored()), true, 'failed cleanup must not pretend credentials were removed');
  await page.getByRole('button', { name: '다시 로그인' }).click();
  await page.getByText('Google로 계속하기').waitFor();
  assert.equal(await page.evaluate(() => window.__d56.stored()), false, 'Auth is allowed only after local cleanup succeeds');

  await page.goto(`${base}/?signout=partial`);
  await page.getByRole('button', { name: '다시 로그인' }).click();
  await page.getByText(/로그인 정보를 정리하지 못했습니다/).waitFor();
  assert.equal(await page.evaluate(() => window.__d56.stored()), false, 'auth-js may already remove the primary key');
  assert.equal(await page.evaluate(() => window.__d56.cleanupPending()), true, 'durable marker preserves the unfinished cleanup boundary');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  assert.equal(await page.getByText('Google로 계속하기').count(), 0, 'null reads cannot bypass cleanupPending');
  await page.getByRole('button', { name: '다시 로그인' }).click();
  await page.getByText('Google로 계속하기').waitFor();
  assert.equal(await page.evaluate(() => window.__d56.cleanupPending()), false, 'SIGNED_OUT clears the cleanup marker');
  assert.deepEqual(errors, []);
  console.log('D56 browser PASS: waiting/recovery + auth ordering + cleanup failure/retry contract');
} finally {
  await browser.close();
}
