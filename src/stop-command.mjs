// Only a standalone instruction is a control command. Never match prose, code or negations.
export function isStopCommand(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim().replace(/^(?:(?:지금|현재)\s+)?(?:(?:하던|진행\s*중인)\s+)?작업(?:을)?\s+|^(?:지금|현재)\s+/u, '');
  // 띄어쓰기·존댓말 변형("멈춰 주세요"·"멈춰요"·"중지해 주세요"·"그만 해")도 같은 명령이다(K48 — 미인식이면 새 턴이 겹쳐 시작).
  return /^(?:멈춰(?:\s*(?:줘|주세요)|요)?|멈추세요|(?:중지|중단|그만)(?:\s*해(?:\s*(?:줘|주세요)|요)?|\s*하세요)?|stop(?: it)?(?: please)?|please stop|cancel|pause)[.!。！\s]*$/iu.test(command);
}
