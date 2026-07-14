export interface AppConfig {
  nodeEnv: string;
  contactEmailFrom: string;
  contactEmailTo: string;
  corsAllowedOrigins: string[];
  rateLimitPerIp: number;
  captchaEnabled: boolean;
  captchaProvider: 'turnstile' | 'hcaptcha';
  captchaSecret: string;
  crmWebhookUrl?: string;
  logLevel: string;
  awsRegion: string;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'production',
    contactEmailFrom: requireEnv('CONTACT_EMAIL_FROM'),
    contactEmailTo: requireEnv('CONTACT_EMAIL_TO'),
    corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimitPerIp: Number(process.env.RATE_LIMIT_PER_IP ?? '10'),
    captchaEnabled: parseBoolean(process.env.CAPTCHA_ENABLED, false),
    captchaProvider:
      process.env.CAPTCHA_PROVIDER === 'hcaptcha' ? 'hcaptcha' : 'turnstile',
    captchaSecret: process.env.CAPTCHA_SECRET ?? '',
    crmWebhookUrl: process.env.CRM_WEBHOOK_URL || undefined,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    awsRegion: process.env.AWS_REGION ?? 'sa-east-1',
  };
}
