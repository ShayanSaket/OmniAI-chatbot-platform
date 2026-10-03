// Lightweight language detection for the supported customer languages (en, de, fa, es,
// fr). Runs on every inbound message without an API call; it only reports a language
// when the evidence is clear, so short messages ("ok", "thanks!") never flip the
// conversation language.

export type DetectedLanguage = 'en' | 'de' | 'fa' | 'es' | 'fr';

const STOPWORDS: Record<Exclude<DetectedLanguage, 'fa'>, string[]> = {
  en: ['the', 'and', 'is', 'are', 'you', 'what', 'how', 'can', 'do', 'does', 'my', 'i', 'to', 'for', 'with', 'have', 'need', 'want', 'please', 'hello', 'hi', 'thanks', 'your', 'it', 'this', 'about', 'price', 'much', 'would', 'like', 'of', 'in'],
  de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'ich', 'sie', 'wir', 'nicht', 'ein', 'eine', 'mit', 'für', 'was', 'wie', 'können', 'kann', 'haben', 'hallo', 'danke', 'bitte', 'mein', 'meine', 'ihr', 'ihre', 'gibt', 'es', 'auf', 'zu', 'auch', 'kostet', 'wäre', 'möchte', 'guten', 'tag', 'den', 'dem', 'noch', 'mir'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'son', 'que', 'qué', 'cómo', 'como', 'para', 'por', 'con', 'una', 'un', 'mi', 'tu', 'su', 'hola', 'gracias', 'quiero', 'necesito', 'puedo', 'puede', 'precio', 'cuánto', 'cuesta', 'tienen', 'del', 'al', 'pero', 'muy', 'buenos', 'días', 'sí'],
  fr: ['le', 'la', 'les', 'et', 'est', 'sont', 'que', 'quoi', 'comment', 'pour', 'avec', 'une', 'un', 'mon', 'ma', 'mes', 'votre', 'vous', 'nous', 'je', 'bonjour', 'merci', 'voudrais', 'besoin', 'puis', 'pouvez', 'prix', 'combien', 'coûte', 'des', 'du', 'au', 'mais', 'très', 'oui', "c'est", "j'ai", 'ce'],
};

const DIACRITICS: { lang: Exclude<DetectedLanguage, 'fa'>; pattern: RegExp; weight: number }[] = [
  { lang: 'de', pattern: /[äöüß]/g, weight: 1.5 },
  { lang: 'es', pattern: /[ñ¿¡]/g, weight: 2 },
  { lang: 'es', pattern: /[áíóú]/g, weight: 0.6 },
  { lang: 'fr', pattern: /[çèêëàâîïôûœ]/g, weight: 1.2 },
];

const STOPWORD_SETS = Object.fromEntries(
  Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]),
) as Record<Exclude<DetectedLanguage, 'fa'>, Set<string>>;

/** Persian-specific letters (absent from Arabic). */
const PERSIAN_LETTERS = /[پچژگکی]/;
const ARABIC_SCRIPT = /[؀-ۿ]/g;

export interface LanguageGuess {
  language: DetectedLanguage;
  confidence: number;
}

export function detectLanguage(text: string): LanguageGuess | null {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, ' ');
  const arabicChars = clean.match(ARABIC_SCRIPT)?.length ?? 0;
  const letters = clean.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return null;
  if (arabicChars / letters > 0.5) {
    // Arabic script: only claim Persian when Persian-only letters appear.
    return PERSIAN_LETTERS.test(clean) ? { language: 'fa', confidence: 0.95 } : null;
  }

  const words = clean.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 2) return null;

  const scores: Record<string, number> = { en: 0, de: 0, es: 0, fr: 0 };
  for (const word of words) {
    for (const lang of Object.keys(STOPWORD_SETS) as (keyof typeof STOPWORD_SETS)[]) {
      if (STOPWORD_SETS[lang].has(word)) scores[lang]! += 1;
    }
  }
  const lower = clean.toLowerCase();
  for (const { lang, pattern, weight } of DIACRITICS) {
    scores[lang]! += (lower.match(pattern)?.length ?? 0) * weight;
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestLang, best] = ranked[0]!;
  const second = ranked[1]![1];
  if (best < 1.5 || best - second < 1) return null;
  const confidence = Math.min(0.95, 0.5 + (best - second) / (words.length + 2));
  return { language: bestLang as DetectedLanguage, confidence };
}

/** Common function words of all supported Latin-script languages (for keyword search). */
export const ALL_STOPWORDS: ReadonlySet<string> = new Set([
  // Detection cue words that carry meaning in a search stay searchable.
  ...Object.values(STOPWORDS)
    .flat()
    .filter((w) => !['price', 'precio', 'prix', 'kostet', 'cuesta', 'coûte', 'need', 'necesito', 'besoin'].includes(w)),
  'a', 'an', 'or', 'be', 'on', 'at', 'we', 'me', 'our', 'can', 'any', 'there', 'tell', 'know',
  'oder', 'aber', 'wo', 'wann', 'gibt', 'bei', 'von', 'im', 'ob',
  'o', 'en', 'se', 'lo', 'le', 'il', 'elle', 'est-ce', 'sur', 'dans',
]);
