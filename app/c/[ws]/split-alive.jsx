'use client';
// 분할 패널 가용 여부 — 한 축, 한 함수. 판정(splitAliveAt)·질의(SPLIT_DEAD_MQ)는 zoom-math.mjs(순수, 테스트가 임포트).
// 소비자(SplitPane 렌더·크루 채팅 '옆에 열기'·회의실 발언자 클릭·사이드바 크루 행·기억 문서 행 진입로)가 이 훅만 쓴다 — 각자 판정하면
// "패널은 죽었는데 진입로는 있는"(무언 실패) 사각이 생긴다. 초기값 true: false면 넓은 폭 첫 프레임에 진입로가 없다.
import { useEffect, useState } from 'react';
import { SPLIT_DEAD_MQ, dispZoom, splitAliveAt } from './zoom-math.mjs';

export function useSplitAlive() {
  const [alive, setAlive] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia(SPLIT_DEAD_MQ);
    const on = () => setAlive(splitAliveAt(mq.matches, window.innerWidth, dispZoom()));
    on();
    // 실뷰포트 축은 mq change, 배율 축은 resize(유효 폭 변화)·argo:zoom(배율 변화) — 하나라도 빠지면 낡은 판정이 남는다
    mq.addEventListener('change', on);
    window.addEventListener('resize', on);
    window.addEventListener('argo:zoom', on);
    return () => {
      mq.removeEventListener('change', on);
      window.removeEventListener('resize', on);
      window.removeEventListener('argo:zoom', on);
    };
  }, []);
  return alive;
}
