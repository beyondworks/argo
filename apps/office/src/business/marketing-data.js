import { createBusinessClient, useScopedBusiness, businessError } from './data.js';
import { validateFilters } from './dashboard-model.js';

export function marketingError(error) {
  const codes = { marketing_input: 'input', marketing_dates: 'dates', marketing_not_found: 'missing', marketing_version_conflict: 'version', marketing_idempotency_conflict: 'pending', marketing_aggregate_limit: 'aggregate' };
  return codes[error?.message] ? `biz.error.${codes[error.message]}` : businessError(error);
}

export function marketingReportArgs(filters) {
  const parsed = validateFilters({ from: filters?.from, to: filters?.to, customer: null });
  const campaign = filters?.campaign ?? null;
  if (campaign !== null && (typeof campaign !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(campaign))) throw new Error('biz.error.input');
  return { p_from: parsed.from, p_to: parsed.to, p_campaign: campaign };
}

export function createMarketingClient(options) {
  return createBusinessClient({ ...options, rpcPrefix: 'office_marketing', journalNamespace: 'argo-office-marketing-pending', reportArgs: marketingReportArgs, mapError: marketingError, versionConflict: 'marketing_version_conflict' });
}

export function useMarketing(space) {
  return useScopedBusiness(space, createMarketingClient);
}
