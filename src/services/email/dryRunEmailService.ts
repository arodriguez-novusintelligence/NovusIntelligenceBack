import type { ContactEmailPayload, EmailService } from './emailService';

/** DEV fallback when SES identities are not verified yet. */
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
