package com.beyondworks.argo.messenger

// 시스템 기본 배치를 쓴다. edge-to-edge로 상태바 뒤까지 그린 뒤 content 뷰 padding으로 보상하려 했으나
// 그 padding은 Tauri WebView에 반영되지 않았고(실측: env(safe-area-inset-top)=0, .msgr-top padding-top=8px,
// 헤더가 상태바와 겹침), insets를 CONSUMED로 삼켜 WebView가 safe-area를 받을 길도 막혀 있었다.
// 키보드는 매니페스트의 adjustResize가 처리한다.
class MainActivity : TauriActivity()
