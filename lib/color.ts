// Color helpers for user-configurable brand colors (widget theming).

function channel(c: number) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex) ?? [79, 70, 229];
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** White or near-black text, whichever reads better on `background`. */
export function readableTextColor(background: string): '#ffffff' | '#0f172a' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#0f172a') ? '#ffffff' : '#0f172a';
}

/** `hex` at `alpha` as an rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex) ?? [79, 70, 229];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
