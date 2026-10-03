/** Only same-site relative paths are accepted as post-login destinations (prevents open redirects). */
export function safeCallbackUrl(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}
