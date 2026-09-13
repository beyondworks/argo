// Only a standalone instruction is a control command. Never match prose, code or negations.
export function isStopCommand(text) {
  if (typeof text !== 'string') return false;
  const command = text.trim().replace(/^(?:(?:지금|현재)\s+)?(?:(?:하던|진행\s*중인)\s+)?작업(?:을)?\s+|^(?:지금|현재)\s+/u, '');
  return /^(?:멈춰(?:줘|주세요)?|멈추세요|중지(?:해(?:줘|주세요)?|해주세요|하세요)?|중단(?:해(?:줘|주세요)?|해주세요|하세요)?|그만(?:해(?:줘|주세요)?|해주세요|하세요)?|stop(?: please)?|please stop|cancel|pause)[.!。！\s]*$/iu.test(command);
}
