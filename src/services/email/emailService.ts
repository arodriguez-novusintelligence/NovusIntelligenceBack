import type { ContactRequest } from '../../types/contact';

export interface ContactEmailPayload {
  requestId: string;
  contact: ContactRequest;
  timestampUtc: string;
}

export interface EmailService {
  sendContactNotification(payload: ContactEmailPayload): Promise<void>;
}
