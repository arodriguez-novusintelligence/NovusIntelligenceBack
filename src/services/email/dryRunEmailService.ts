import type { ContactEmailPayload, EmailService } from './emailService';

/** Local development only — activated when NODE_ENV=development and EMAIL_DRY_RUN=true. */
export class DryRunEmailService implements EmailService {
  async sendContactNotification(payload: ContactEmailPayload): Promise<void> {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'email_dry_run',
        requestId: payload.requestId,
        timestampUtc: payload.timestampUtc,
        contact: {
          name: payload.contact.name,
          email: payload.contact.email,
          company: payload.contact.company ?? null,
          solutionInterest: payload.contact.solutionInterest ?? null,
        },
      }),
    );
  }
}
