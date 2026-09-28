// Browser-safe effort contract shared by the crew editor, card storage and Codex transports.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEGACY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const GPT6_EFFORTS = {
  'gpt-6-sol': [...CLAUDE_EFFORTS, 'ultra'],
  'gpt-6-luna': [...CLAUDE_EFFORTS],
};
const modelEfforts = (model) => Object.hasOwn(GPT6_EFFORTS, model) ? GPT6_EFFORTS[model] : null;

export function effortLevels(runner, model) {
  return runner === 'codex' && modelEfforts(model) ? modelEfforts(model) : CLAUDE_EFFORTS;
}

export function normalizeCrewEffort(effort, runner, model) {
  const value = String(effort ?? '').trim().toLowerCase();
  return effortLevels(runner, model).includes(value) ? value : '';
}

export function codexModelEffort(effort, model) {
  const value = String(effort ?? '').trim().toLowerCase();
  const supported = modelEfforts(model);
  if (supported) return supported.includes(value) ? value : null;
  const mapped = value === 'max' ? 'xhigh' : value;
  return CODEX_LEGACY_EFFORTS.includes(mapped) ? mapped : null;
}
