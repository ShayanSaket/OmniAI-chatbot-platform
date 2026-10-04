// Groups short customer messages into topics by shared keywords. Deterministic, local and
// free (no AI call), multilingual for the supported languages. Pure and client-safe.
import { ALL_STOPWORDS } from './language';

/** Chat filler that says nothing about the topic (all supported languages). */
const FILLER = new Set([
  // en
  'hello', 'hey', 'thanks', 'thank', 'please', 'help', 'question', 'questions', 'want', 'would', 'like', 'could', 'should', 'need', 'about',
  'does', 'have', 'has', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'your', 'you', 'yes', 'okay', 'ok', 'good', 'great', 'also',
  'just', 'still', 'really', 'much', 'many', 'some', 'there', 'here', 'this', 'that', 'these', 'those', 'get', 'got', 'possible', 'way',
  'one', 'two', 'any', 'all', 'more', 'other', 'again', 'today', 'now', 'will', 'can', 'did', 'are', 'was', 'were', 'the', 'and', 'for',
  'with', 'from', 'into', 'than', 'then', 'them', 'they', 'their', 'our', 'my', 'mine', 'its', 'not', 'don', 'doesn', 'isn', 'aren', 'cannot',
  // generic verbs (they describe the request, not the topic)
  'add', 'adding', 'send', 'make', 'use', 'using', 'find', 'see', 'show', 'give', 'set', 'change', 'offer', 'provide', 'work', 'works', 'start',
  'check', 'tell', 'let', 'look', 'looking', 'try', 'put', 'paste', 'thing', 'something', 'anything', 'everything', 'someone', 'please',
  'inkl', 'zzgl', 'etc', 'bzw', 'usw', 'trage', 'tragen', 'eintragen', 'machen', 'mache', 'sehen', 'finde', 'finden', 'schicken', 'senden',
  'brauche', 'brauchen', 'suche', 'suchen', 'funktioniert', 'puedo', 'necesito', 'envoyer', 'faire', 'añadir', 'ajouter',
  // de
  'hallo', 'danke', 'bitte', 'frage', 'fragen', 'hilfe', 'möchte', 'möchten', 'würde', 'gerne', 'gern', 'kann', 'können', 'könnte', 'habe',
  'haben', 'hat', 'wie', 'was', 'wann', 'welche', 'welcher', 'warum', 'ihr', 'ihre', 'ihren', 'sie', 'mir', 'mich', 'uns', 'noch', 'auch',
  'unser', 'unsere', 'unseren', 'unserer', 'unserem', 'mein', 'meine', 'meinen', 'meiner', 'dein', 'deine', 'euer', 'eure',
  'schon', 'mal', 'gibt', 'geht', 'gut', 'okay', 'heute', 'jetzt', 'denn', 'dass', 'eine', 'einen', 'einem', 'einer', 'keine', 'nicht',
  // es / fr
  'hola', 'gracias', 'favor', 'pregunta', 'ayuda', 'quiero', 'quisiera', 'puedo', 'puede', 'tengo', 'tiene', 'cómo', 'como', 'qué', 'cuándo',
  'bonjour', 'merci', 'question', 'aide', 'voudrais', 'veux', 'peux', 'peut', 'avez', 'comment', 'quoi', 'quand', 'pour', 'avec', 'votre',
  // fa
  'سلام', 'ممنون', 'مرسی', 'لطفا', 'لطفاً', 'سوال', 'کمک', 'میخواهم', 'می‌خواهم', 'دارید', 'دارم', 'چطور', 'چگونه', 'چه', 'چی', 'کی', 'آیا',
  'از', 'به', 'در', 'با', 'که', 'این', 'آن', 'را', 'برای', 'هم', 'یک', 'است', 'هست', 'من', 'شما', 'ما', 'تا', 'یا', 'اما', 'بر', 'می', 'شود',
]);

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}‌'-]*/gu;

/** Light stemming so "installation", "installing" and "install" (or "prices"/"price") match. */
export function normalizeTerm(word: string): string {
  let w = word.toLowerCase().normalize('NFKC').replace(/['’-]+$/g, '');
  if (w.length > 7 && /ations?$/.test(w)) w = w.replace(/ations?$/, '');
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  return w;
}

interface Token {
  term: string;
  /** The word as the customer wrote it (for labels: "API", "installation"). */
  surface: string;
}

/** Emails, links and handles say nothing about the topic. */
const NOISE = /[\w.+-]+@[\w-]+\.[\w.-]+|https?:\/\/\S+|www\.\S+/gi;

function tokens(text: string): Token[] {
  const seen = new Map<string, Token>();
  for (const word of text.replace(NOISE, ' ').match(TOKEN) ?? []) {
    const raw = word.replace(/['’-]+$/g, '');
    const lower = raw.toLowerCase();
    if (lower.length < 3 && !/^\d{2,}$/.test(lower)) continue;
    if (/^\d+$/.test(lower) && lower.length < 4) continue;
    if (ALL_STOPWORDS.has(lower) || FILLER.has(lower)) continue;
    const term = normalizeTerm(lower);
    if (term.length < 3 || FILLER.has(term) || ALL_STOPWORDS.has(term)) continue;
    // Keep acronyms ("API", "VAT") as written; other words lower-case.
    if (!seen.has(term)) seen.set(term, { term, surface: raw.length <= 5 && raw === raw.toUpperCase() && /\p{Lu}/u.test(raw) ? raw : lower });
  }
  return [...seen.values()];
}

/** Topic-bearing word stems of a message, in order of first appearance, without duplicates. */
export function keywords(text: string): string[] {
  return tokens(text).map((t) => t.term);
}

export interface Clustered<T> {
  label: string;
  terms: string[];
  items: T[];
}

/**
 * Greedy keyword clustering: repeatedly takes the term shared by most remaining
 * messages, groups those messages, and labels the group with that term plus a strong
 * co-occurring term ("installation guide"). Small leftovers are not forced into topics.
 */
export function clusterTopics<T extends { text: string }>(items: T[], opts: { minSize?: number; maxClusters?: number } = {}): Clustered<T>[] {
  const minSize = opts.minSize ?? 2;
  const maxClusters = opts.maxClusters ?? 10;
  let remaining = items
    .map((item) => {
      const toks = tokens(item.text);
      return { item, terms: toks.map((t) => t.term), surfaces: new Map(toks.map((t) => [t.term, t.surface])) };
    })
    .filter((d) => d.terms.length > 0);
  const clusters: Clustered<T>[] = [];

  while (clusters.length < maxClusters && remaining.length >= minSize) {
    const df = new Map<string, number>();
    for (const d of remaining) for (const t of d.terms) df.set(t, (df.get(t) ?? 0) + 1);
    let best: string | null = null;
    let bestCount = 0;
    for (const [term, count] of df) {
      if (count > bestCount || (count === bestCount && best !== null && (term.length > best.length || (term.length === best.length && term < best)))) {
        best = term;
        bestCount = count;
      }
    }
    if (!best || bestCount < minSize) break;

    const members = remaining.filter((d) => d.terms.includes(best!));
    const co = new Map<string, number>();
    for (const d of members) for (const t of d.terms) if (t !== best) co.set(t, (co.get(t) ?? 0) + 1);
    const threshold = Math.max(2, Math.ceil(members.length * 0.5));
    const partner = [...co.entries()].filter(([, n]) => n >= threshold).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

    // Label words in the order customers tend to write them.
    let terms = partner ? [best, partner] : [best];
    if (partner) {
      const first = members.find((d) => d.terms.includes(partner))!;
      if (first.terms.indexOf(partner) < first.terms.indexOf(best)) terms = [partner, best];
    }
    // Label with the word form customers used most ("installation", not the stem "install").
    const surface = (term: string) => {
      const counts = new Map<string, number>();
      for (const d of members) {
        const w = d.surfaces.get(term);
        if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? term;
    };
    clusters.push({ label: terms.map(surface).join(' '), terms, items: members.map((m) => m.item) });
    const taken = new Set(members);
    remaining = remaining.filter((d) => !taken.has(d));
  }
  return clusters.sort((a, b) => b.items.length - a.items.length);
}

/** Most frequent keywords across messages (one count per message). */
export function topKeywords(texts: string[], limit = 15): { term: string; count: number }[] {
  const df = new Map<string, number>();
  const forms = new Map<string, Map<string, number>>();
  for (const t of texts) {
    for (const tok of tokens(t)) {
      df.set(tok.term, (df.get(tok.term) ?? 0) + 1);
      const f = forms.get(tok.term) ?? new Map<string, number>();
      f.set(tok.surface, (f.get(tok.surface) ?? 0) + 1);
      forms.set(tok.term, f);
    }
  }
  const label = (term: string) => [...(forms.get(term) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] ?? term;
  return [...df.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term: label(term), count }));
}
