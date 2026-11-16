// Browser-safe effort contract shared by the crew editor, card storage and Codex transports.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_LEGACY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
// Levels follow the Codex server model list (supported_reasoning_levels, ~/.codex/models_cache.json 2026-10-07).
const GPT6_EFFORTS = {
  'gpt-6.1-sol': [...CLAUDE_EFFORTS, 'ultra'],
  'gpt-6.1-terra': [...CLAUDE_EFFORTS, 'ultra'], // codex debug models(0.162.1) 2026-11-16: low~max·ultra, 서버 기본 low — 6.1 Sol과 같다
  'gpt-6-astra': [...CLAUDE_EFFORTS, 'ultra'],
  'gpt-6-sol': [...CLAUDE_EFFORTS, 'ultra'],
  'gpt-6-luna': [...CLAUDE_EFFORTS],
};
// Effort sent when the crew leaves it empty. Server default for gpt-6.1-sol is low; Yugeon decided medium (2026-10-08).
// Storage keeps '' — the value is filled only on the wire, so a later default change needs no card migration.
// gpt-6.1-terra(2026-11-16): 서버 기본이 6.1 Sol과 같은 low라 같은 결정(medium)을 따른다 — 바꾸려면 이 표만.
const EMPTY_EFFORT = { 'gpt-6.1-sol': 'medium', 'gpt-6.1-terra': 'medium' };
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
  if (supported) return supported.includes(value) ? value : (EMPTY_EFFORT[model] ?? null);
  const mapped = value === 'max' ? 'xhigh' : value;
  return CODEX_LEGACY_EFFORTS.includes(mapped) ? mapped : null;
}
