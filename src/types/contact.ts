export const SOLUTION_INTERESTS = [
  'ai-agents',
  'automation',
  'integrations',
  'analytics',
  'documents-ai',
  'customer-ai',
] as const;

export type SolutionInterest = (typeof SOLUTION_INTERESTS)[number];

export interface ContactRequest {
  name: string;
  company?: string;
  email: string;
  phone?: string;
  message: string;
  solutionInterest?: SolutionInterest;
  captchaToken?: string;
}

export interface ContactFieldError {
  field: string;
  code: string;
  message: string;
}

export interface ContactResponse {
  ok: boolean;
  requestId: string;
  message: string;
  errors?: ContactFieldError[];
}

export interface ValidationResult {
  valid: boolean;
  data?: ContactRequest;
  errors: ContactFieldError[];
}
