import type {
  EmailDeliveryListQuery,
  EmailDeliveryView,
  EmailSettingsView,
  SendTestEmailRequest,
  SendTestEmailResult,
  UpdateEmailSettingsRequest,
} from '@palcert/contracts/email';
import type { Page } from '@palcert/contracts';
import { apiRequest } from './api-client';

/**
 * Platform email administration, as the browser calls it (ADR-0146).
 *
 * The settings view never contains a credential. A key or secret travels in
 * one direction only — in the body of a save — and is not kept in any state
 * after the request is sent.
 */
function query(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

export const emailAdminApi = {
  settings: () => apiRequest<EmailSettingsView>('/admin/email-settings'),
  save: (input: UpdateEmailSettingsRequest) =>
    apiRequest<EmailSettingsView>('/admin/email-settings', { method: 'PUT', body: input }),
  sendTest: (input: SendTestEmailRequest) =>
    apiRequest<SendTestEmailResult>('/admin/email-settings/test', { method: 'POST', body: input }),
  deliveries: (params: EmailDeliveryListQuery = {}) =>
    apiRequest<Page<EmailDeliveryView>>(
      `/admin/email-deliveries${query(params as Record<string, string | number | undefined>)}`,
    ),
  delivery: (id: string) =>
    apiRequest<EmailDeliveryView>(`/admin/email-deliveries/${encodeURIComponent(id)}`),
};
