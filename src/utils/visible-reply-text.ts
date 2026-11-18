// Keep the fixed platform annotations out of user-visible replies. This is
// shared with source attribution so a ref inside a removed annotation cannot
// earn an explicit-answer marker. Ordinary user/assistant brackets survive.
export function stripInternalAnnotations(text: string): string {
  return text.replace(/\s*\[续聊凭据[^\]]*\]/g, '').trim();
}

export function explicitlyVisibleReference(text: string, ref: string): boolean {
  const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_:/.-])${escaped}(?=$|[^A-Za-z0-9_:/.-])`, 'u').test(text);
}
