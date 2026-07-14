import {
  SOLUTION_INTERESTS,
  type ContactFieldError,
  type ContactRequest,
  type ValidationResult,
} from '../../types/contact';
import { sanitizeText } from '../sanitize/sanitize';

const EMAIL_REGEX =
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PHONE_REGEX = /^[\d+\-\s()]{0,40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

export function validateContactRequest(body: unknown): ValidationResult {
  const errors: ContactFieldError[] = [];

  if (!isRecord(body)) {
    return {
      valid: false,
      errors: [
        {
          field: 'body',
          code: 'invalid_json',
          message: 'El cuerpo de la solicitud debe ser JSON válido.',
        },
      ],
    };
  }

  const rawName = body.name;
  const rawEmail = body.email;
  const rawMessage = body.message;
  const rawCompany = asOptionalString(body.company);
  const rawPhone = asOptionalString(body.phone);
  const rawSolutionInterest = asOptionalString(body.solutionInterest);
  const rawCaptchaToken = asOptionalString(body.captchaToken);

  if (typeof rawName !== 'string') {
    errors.push({
      field: 'name',
      code: 'required',
      message: 'El nombre es obligatorio.',
    });
  } else {
    const name = sanitizeText(rawName);
    if (name.length < 2 || name.length > 120) {
      errors.push({
        field: 'name',
        code: 'invalid_length',
        message: 'El nombre debe tener entre 2 y 120 caracteres.',
      });
    }
  }

  if (typeof rawEmail !== 'string') {
    errors.push({
      field: 'email',
      code: 'required',
      message: 'El email es obligatorio.',
    });
  } else {
    const email = sanitizeText(rawEmail).toLowerCase();
    if (email.length > 254 || !EMAIL_REGEX.test(email)) {
      errors.push({
        field: 'email',
        code: 'invalid_format',
        message: 'Formato de email inválido.',
      });
    }
  }

  if (typeof rawMessage !== 'string') {
    errors.push({
      field: 'message',
      code: 'required',
      message: 'El mensaje es obligatorio.',
    });
  } else {
    const message = sanitizeText(rawMessage);
    if (message.length < 5 || message.length > 4000) {
      errors.push({
        field: 'message',
        code: 'invalid_length',
        message: 'El mensaje debe tener entre 5 y 4000 caracteres.',
      });
    }
  }

  if (rawCompany !== undefined) {
    const company = sanitizeText(rawCompany);
    if (company.length > 160) {
      errors.push({
        field: 'company',
        code: 'invalid_length',
        message: 'La empresa no puede superar 160 caracteres.',
      });
    }
  }

  if (rawPhone !== undefined) {
    const phone = sanitizeText(rawPhone);
    if (phone.length > 40 || !PHONE_REGEX.test(phone)) {
      errors.push({
        field: 'phone',
        code: 'invalid_format',
        message: 'Formato de teléfono inválido.',
      });
    }
  }

  if (rawSolutionInterest !== undefined) {
    if (!SOLUTION_INTERESTS.includes(rawSolutionInterest as (typeof SOLUTION_INTERESTS)[number])) {
      errors.push({
        field: 'solutionInterest',
        code: 'invalid_enum',
        message: 'Interés de solución no válido.',
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const data: ContactRequest = {
    name: sanitizeText(rawName as string),
    email: sanitizeText(rawEmail as string).toLowerCase(),
    message: sanitizeText(rawMessage as string),
  };

  if (rawCompany !== undefined) {
    data.company = sanitizeText(rawCompany);
  }
  if (rawPhone !== undefined) {
    data.phone = sanitizeText(rawPhone);
  }
  if (rawSolutionInterest !== undefined) {
    data.solutionInterest = rawSolutionInterest as ContactRequest['solutionInterest'];
  }
  if (rawCaptchaToken !== undefined) {
    data.captchaToken = sanitizeText(rawCaptchaToken);
  }

  return { valid: true, data, errors: [] };
}

export function getValidationSummary(errors: ContactFieldError[]): string {
  if (errors.length === 0) {
    return 'Solicitud inválida.';
  }
  const first = errors[0];
  if (first.field === 'email' && first.code === 'invalid_format') {
    return 'El campo email no tiene un formato válido.';
  }
  if (first.field === 'name') {
    return 'El campo nombre no es válido.';
  }
  if (first.field === 'message') {
    return 'El campo mensaje no es válido.';
  }
  return first.message;
}
