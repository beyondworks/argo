// 채널 머리 필터 탭 숫자 = 읽지 않은 것(D45, 알림함 탭 #636과 같은 기준).
// 실측(ego, 폰 390 픽스처: 읽은 멘션 3 + 새 멘션 2): main '멘션 5' → 수정 뒤 '멘션 2'
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('멘션·에이전트 탭은 열 때의 읽음 커서 뒤(내 글 제외), 결재는 대기 중인 것', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /const unreadHere = \(m\) => m\.id > divider && !\(m\.author_kind === 'user' && m\.author_user_id === uid\);/);
  assert.match(src, /const counts = \{ mention: all\.filter\(\(m\) => isMention\(m\) && unreadHere\(m\)\)\.length, approval: all\.filter\(isPending\)\.length, crew: all\.filter\(\(m\) => m\.author_kind === 'crew' && unreadHere\(m\)\)\.length \};/);
});
