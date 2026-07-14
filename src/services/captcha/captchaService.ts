import type { AppConfig } from '../../lib/config/env';

export interface CaptchaVerificationResult {
  valid: boolean;
  error?: string;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const HCAPTCHA_VERIFY_URL = 'https://hcaptcha.com/siteverify';

export async function verifyCaptchaToken(
  config: AppConfig,
  token: string | undefined,
  remoteIp?: string,
): Promise<CaptchaVerificationResult> {
  if (!config.captchaEnabled) {
    return { valid: true };
  }

  if (!token) {
    return {
      valid: false,
      error: 'El token de captcha es obligatorio.',
    };
  }

  if (!config.captchaSecret) {
    return {
      valid: false,
      error: 'Configuración de captcha incompleta.',
    };
  }

  const verifyUrl =
    config.captchaProvider === 'hcaptcha'
      ? HCAPTCHA_VERIFY_URL
      : TURNSTILE_VERIFY_URL;

  const body = new URLSearchParams({
    secret: config.captchaSecret,
    response: token,
  });

  if (remoteIp) {
    body.set('remoteip', remoteIp);
  }

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    return {
      valid: false,
      error: 'No se pudo verificar el captcha.',
    };
  }

  const result = (await response.json()) as { success?: boolean };

  if (!result.success) {
    return {
      valid: false,
      error: 'Token de captcha inválido.',
    };
  }

  return { valid: true };
}
