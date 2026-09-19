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
  assert.deepEqual(errors, []);
  console.log('D56 browser PASS: waiting → automatic recovery → SIGNED_OUT/D10 Auth');
} finally {
  await browser.close();
}
