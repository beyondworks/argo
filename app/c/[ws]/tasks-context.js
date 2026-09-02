'use client';
// 회사 셸(layout.jsx)이 폴링하는 /api/companies/[ws]/tasks 응답(running/recent)을 자식 페이지가 읽는 통로.
// 데크 크루 카드가 사이드바 링·작업 독 배지와 **같은 목록**을 보게 한다 — 페이지가 /tasks를 따로 폴링하면
// 셋이 서로 다른 시점의 진실을 보고 어긋난다(데크 "전원 대기 중" vs 사이드바 링 켜짐, 2026-09-02 실측).
import { createContext, useContext } from 'react';

export const TasksContext = createContext(null);
/** null = 첫 폴 전(모름). 소비자는 running이 빈 것과 구분하지 않아도 된다 — 둘 다 '대기'로 그린다. */
export const useTasks = () => useContext(TasksContext);
