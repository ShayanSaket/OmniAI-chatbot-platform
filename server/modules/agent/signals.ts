// Message signals: intent, sentiment, lead temperature, escalation category and explicit
// requests for a person. This file holds the shared types and the keyword heuristic used
// when no AI provider is available (or it fails). Pure.
import type { Intent, LeadTemperature } from '@prisma/client';
import { detectLanguage } from '@/lib/language';

export const INTENTS = ['FAQ', 'SALES', 'SUPPORT', 'PRICING', 'DEMO', 'CONTACT', 'COMPLAINT', 'TECHNICAL', 'OTHER'] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'] as const;
export const ESCALATION_CATEGORIES = ['none', 'complaint', 'legal', 'payment', 'technical', 'safety'] as const;

export type Sentiment = (typeof SENTIMENTS)[number];
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

export interface MessageSignals {
  intent: Intent;
  sentiment: Sentiment;
  leadTemperature: LeadTemperature | null;
  escalation: EscalationCategory;
  /** The customer explicitly asks for a human. */
  wantsHuman: boolean;
  language: string | null;
  confidence: number;
  source: 'llm' | 'heuristic';
}

const rx = (words: string[]) => new RegExp(`(?:^|[^\\p{L}])(?:${words.join('|')})`, 'iu');

const WANTS_HUMAN = rx([
  'human', 'real person', 'a person', 'someone from', 'speak to (?:an? )?(?:agent|someone|person)', 'talk to (?:an? )?(?:agent|someone|person|human)', 'live agent', 'customer service rep',
  'mensch', 'mitarbeiter', 'echte[nr]? person', 'kundenservice sprechen', 'jemanden sprechen',
  'humano', 'una persona', 'agente real', 'hablar con alguien',
  'humain', 'une personne', 'un conseiller', 'parler à quelqu',
  'انسان', 'اپراتور', 'پشتیبان واقعی', 'با یک نفر',
]);

const ANGRY = rx([
  'unacceptable', 'ridiculous', 'terrible', 'worst', 'furious', 'angry', 'scam', 'fraud', 'useless', 'disgusting', 'fed up', 'wtf',
  'unverschämt', 'frechheit', 'katastrophe', 'unfassbar', 'betrug', 'sauer', 'wütend', 'inakzeptabel',
  'inaceptable', 'vergüenza', 'estafa', 'harto', 'furioso',
  'inadmissible', 'honteux', 'arnaque', 'furieux', 'inacceptable',
  'افتضاح', 'کلاهبرداری', 'عصبانی',
]);
const NEGATIVE = rx(['not working', 'disappointed', 'problem', 'issue', 'broken', 'funktioniert nicht', 'enttäuscht', 'no funciona', 'ne fonctionne pas', 'déçu', 'مشکل', 'کار نمی']);
const POSITIVE = rx(['thanks', 'thank you', 'great', 'perfect', 'awesome', 'danke', 'super', 'toll', 'gracias', 'genial', 'merci', 'parfait', 'ممنون', 'عالی']);

const LEGAL = rx(['lawyer', 'attorney', 'legal action', 'lawsuit', 'sue ', 'gdpr', 'data protection', 'delete my data', 'anwalt', 'klage', 'rechtlich', 'dsgvo', 'datenschutz', 'abogado', 'demanda', 'avocat', 'poursuite', 'rgpd', 'وکیل', 'شکایت']);
const PAYMENT = rx(['refund', 'charged twice', 'double charged', 'payment failed', 'chargeback', 'invoice wrong', 'overcharged', 'billing', 'rückerstattung', 'doppelt abgebucht', 'zahlung', 'rechnung falsch', 'reembolso', 'cobro', 'remboursement', 'prélèvement', 'facturation', 'بازپرداخت', 'پرداخت']);
const SAFETY = rx(['emergency', 'danger', 'injured', 'fire', 'notfall', 'gefahr', 'verletzt', 'emergencia', 'urgence', 'blessé', 'اورژانس', 'خطر']);
const COMPLAINT = rx(['complain', 'complaint', 'beschwerde', 'beschweren', 'reclamación', 'queja', 'plainte', 'réclamation', 'شکایت']);

const DEMO = rx(['demo', 'trial', 'test drive', 'vorführung', 'testen', 'probar', 'prueba', 'démonstration', 'essai', 'دمو']);
const PRICING = rx(['price', 'pricing', 'cost', 'how much', 'quote', 'plan', 'subscription', 'preis', 'kosten', 'kostet', 'angebot', 'tarif', 'precio', 'cuánto', 'cuesta', 'presupuesto', 'prix', 'combien', 'devis', 'tarif', 'قیمت', 'هزینه', 'تعرفه']);
const SALES = rx(['buy', 'purchase', 'sign up', 'interested in', 'consultation', 'implementation', 'kaufen', 'bestellen', 'interessiert', 'beratung', 'comprar', 'interesado', 'consulta', 'acheter', 'intéressé', 'خرید', 'علاقه']);
const TECHNICAL = rx(['api', 'integration', 'webhook', 'error', 'bug', 'install', 'configure', 'sdk', 'fehler', 'einrichten', 'schnittstelle', 'configurar', 'erreur', 'intégration', 'خطا', 'نصب']);
const SUPPORT = rx(['help', 'support', 'not working', 'problem', 'issue', 'account', 'login', 'password', 'hilfe', 'problem', 'konto', 'ayuda', 'soporte', 'aide', 'compte', 'کمک', 'پشتیبانی']);
const CONTACT = rx(['contact', 'email', 'phone', 'call me', 'address', 'kontakt', 'telefon', 'rückruf', 'anrufen', 'contacto', 'llamar', 'téléphone', 'appeler', 'تماس', 'تلفن']);

const intentScore = (text: string): Intent => {
  if (COMPLAINT.test(text) || ANGRY.test(text)) return 'COMPLAINT';
  if (DEMO.test(text)) return 'DEMO';
  // Explicit purchase wording beats price words ("buy the starter plan").
  if (SALES.test(text)) return 'SALES';
  if (PRICING.test(text)) return 'PRICING';
  if (TECHNICAL.test(text)) return 'TECHNICAL';
  if (SUPPORT.test(text)) return 'SUPPORT';
  if (CONTACT.test(text)) return 'CONTACT';
  if (/[?？؟]/.test(text)) return 'FAQ';
  return 'OTHER';
};

export function temperatureForIntent(intent: Intent): LeadTemperature | null {
  if (intent === 'DEMO') return 'HOT';
  if (intent === 'PRICING' || intent === 'SALES') return 'WARM';
  return null;
}

export function heuristicSignals(text: string): MessageSignals {
  const intent = intentScore(text);
  const letters = text.replace(/[^\p{L}]/gu, '');
  const shouting = letters.length >= 12 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
  const sentiment: Sentiment =
    ANGRY.test(text) || shouting || /!{3,}/.test(text)
      ? 'angry'
      : NEGATIVE.test(text)
        ? 'negative'
        : POSITIVE.test(text)
          ? 'positive'
          : 'neutral';
  const escalation: EscalationCategory = SAFETY.test(text)
    ? 'safety'
    : LEGAL.test(text)
      ? 'legal'
      : PAYMENT.test(text)
        ? 'payment'
        : COMPLAINT.test(text)
          ? 'complaint'
          : 'none';
  return {
    intent,
    sentiment,
    leadTemperature: temperatureForIntent(intent),
    escalation,
    wantsHuman: WANTS_HUMAN.test(text),
    language: detectLanguage(text)?.language ?? null,
    confidence: 0.5,
    source: 'heuristic',
  };
}

const TEMPERATURE_RANK: Record<LeadTemperature, number> = { COLD: 0, WARM: 1, HOT: 2 };

/** Lead temperature only goes up within a conversation. */
export function warmer(current: LeadTemperature | null, next: LeadTemperature | null): LeadTemperature | null {
  if (!next) return current;
  if (!current) return next;
  return TEMPERATURE_RANK[next] > TEMPERATURE_RANK[current] ? next : current;
}
