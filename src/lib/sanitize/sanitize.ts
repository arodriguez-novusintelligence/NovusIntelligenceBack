export function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

export function sanitizeText(value: string): string {
  const cleaned = stripHtml(value);
  // eslint-disable-next-line no-control-regex -- strip control characters from user input
  return cleaned.replace(/[\u0000-\u001F\u007F]/g, '').trim();
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
