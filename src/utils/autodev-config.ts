export function getAutoDevServerUrl(): string {
  return String(
    process.env.AUTODEV_SERVER_URL
    || process.env.XIAOBA_AUTODEV_SERVER_URL
    || '',
  ).trim().replace(/\/+$/, '');
}

export function getAutoDevApiKey(): string {
  return String(process.env.AUTODEV_API_KEY || '').trim();
}

export function isAutoDevConfigured(): boolean {
  return !!getAutoDevServerUrl();
}
