import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { AppConfig } from '../../lib/config/env';
import { escapeHtml } from '../../lib/sanitize/sanitize';
import type { ContactEmailPayload, EmailService } from './emailService';

export class SesEmailService implements EmailService {
  private readonly client: SESClient;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = new SESClient({ region: config.awsRegion });
  }

  async sendContactNotification(payload: ContactEmailPayload): Promise<void> {
    const { contact, requestId, timestampUtc } = payload;
    const subject = `[Novus Intelligence] Nuevo contacto — ${contact.name}`;

    const textBody = [
      'Nuevo mensaje de contacto',
      '',
      `Request ID: ${requestId}`,
      `Timestamp (UTC): ${timestampUtc}`,
      `Nombre: ${contact.name}`,
      `Empresa: ${contact.company ?? '—'}`,
      `Email: ${contact.email}`,
      `Teléfono: ${contact.phone ?? '—'}`,
      `Interés: ${contact.solutionInterest ?? '—'}`,
      '',
      'Mensaje:',
      contact.message,
    ].join('\n');

    const htmlBody = `
      <h2>Nuevo mensaje de contacto</h2>
      <p><strong>Request ID:</strong> ${escapeHtml(requestId)}</p>
      <p><strong>Timestamp (UTC):</strong> ${escapeHtml(timestampUtc)}</p>
      <ul>
        <li><strong>Nombre:</strong> ${escapeHtml(contact.name)}</li>
        <li><strong>Empresa:</strong> ${escapeHtml(contact.company ?? '—')}</li>
        <li><strong>Email:</strong> ${escapeHtml(contact.email)}</li>
        <li><strong>Teléfono:</strong> ${escapeHtml(contact.phone ?? '—')}</li>
        <li><strong>Interés:</strong> ${escapeHtml(contact.solutionInterest ?? '—')}</li>
      </ul>
      <p><strong>Mensaje:</strong></p>
      <p>${escapeHtml(contact.message).replace(/\n/g, '<br />')}</p>
    `.trim();

    await this.client.send(
      new SendEmailCommand({
        Source: this.config.contactEmailFrom,
        Destination: {
          ToAddresses: [this.config.contactEmailTo],
        },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: textBody, Charset: 'UTF-8' },
            Html: { Data: htmlBody, Charset: 'UTF-8' },
          },
        },
        ReplyToAddresses: [contact.email],
      }),
    );
  }
}

export function createEmailService(config: AppConfig): EmailService {
  return new SesEmailService(config);
}
