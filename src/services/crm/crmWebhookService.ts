import type { AppConfig } from '../../lib/config/env';
import { logStructured } from '../../lib/response/httpResponse';
import type { ContactRequest } from '../../types/contact';

const WEBHOOK_TIMEOUT_MS = 3000;

export async function notifyCrmWebhook(
  config: AppConfig,
  requestId: string,
  contact: ContactRequest,
): Promise<void> {
  if (!config.crmWebhookUrl) {
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const response = await fetch(config.crmWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId,
        contact,
        timestampUtc: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logStructured({
        level: 'warn',
        event: 'crm_webhook_failed',
        requestId,
        status: response.status,
      });
    }
  } catch (error) {
    logStructured({
      level: 'warn',
      event: 'crm_webhook_error',
      requestId,
      message: error instanceof Error ? error.message : 'unknown_error',
    });
  } finally {
    clearTimeout(timeout);
  }
}
