// Only a standalone instruction is a control command. Never match prose, code or negations.
export function isStopCommand(text) {
  if (typeof text !== 'string') return false;
  return /^(?:멈춰(?:줘|주세요)?|멈추세요|중지(?:해(?:줘|주세요)?|해주세요|하세요)?|중단(?:해(?:줘|주세요)?|해주세요|하세요)?|그만(?:해(?:줘|주세요)?|해주세요|하세요)?|stop(?: please)?|please stop|cancel|pause)[.!。！\s]*$/iu.test(text.trim());
}
