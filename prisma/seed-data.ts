// Demo content for NovaTech GmbH. Kept separate from the seed mechanics for readability.
import type { ChannelType, ConversationStatus, Intent, LeadStatus, LeadTemperature } from '@prisma/client';

export const NOVATECH = {
  name: 'NovaTech GmbH',
  industry: 'Software & Digital Solutions',
  website: 'https://novatech.example',
  timezone: 'Europe/Berlin',
  defaultLanguage: 'en',
  businessDescription:
    'NovaTech GmbH is a Berlin-based software company that builds AI customer-service solutions, websites and custom integrations for small and mid-sized businesses in the DACH region.',
};

export const TEAM = [
  { email: 'owner@novatech.demo', name: 'Lena Hoffmann', role: 'OWNER' as const },
  { email: 'admin@novatech.demo', name: 'Jonas Weber', role: 'ADMIN' as const },
  { email: 'agent@novatech.demo', name: 'Sara Rahimi', role: 'AGENT' as const },
  { email: 'agent2@novatech.demo', name: 'Tom Becker', role: 'AGENT' as const },
];

// The name and company come from the bot settings; this layer adds the custom instructions.
export const BUSINESS_IDENTITY = `Be friendly and professional. Answer questions using the company knowledge base and the product catalog.
When visitors compare plans, ask about their monthly conversation volume and channels before recommending one.`;

export const BUSINESS_RULES = `- Never invent prices. Only quote prices from the product catalog or the knowledge base; for custom work, offer a quote from sales.
- Demos are booked by the sales team: collect name, email and preferred time, then create a lead.
- Billing disputes, refunds and legal questions always go to a human.
- Support hours are Monday–Friday, 09:00–18:00 (Europe/Berlin).`;

export const KNOWLEDGE: { title: string; sourceType: 'MANUAL' | 'FAQ' | 'MARKDOWN'; fileName?: string; text: string }[] = [
  {
    title: 'Services overview',
    sourceType: 'MARKDOWN',
    fileName: 'services.md',
    text: `# NovaTech services

## AI customer-service chatbot
An AI agent for your website and WhatsApp that answers questions from your own documentation, captures leads and hands conversations to your team when needed. Includes a unified inbox, analytics and lead management.

## Website development
Fast, accessible business websites built with Next.js, including CMS setup and SEO basics.

## Integrations
Connections to HubSpot, Pipedrive and Salesforce, and automation via Zapier, Make or n8n. Custom API integrations on request.

## Implementation
A typical chatbot rollout takes 1–2 weeks: kickoff, knowledge-base setup, widget installation, WhatsApp verification with Meta, and team training.`,
  },
  {
    title: 'Pricing FAQ',
    sourceType: 'FAQ',
    text: `Q: How much does the chatbot cost?
A: Starter is €149 per month (website chat, up to 1,000 conversations). Growth is €399 per month (website + WhatsApp, up to 5,000 conversations, lead management and automations). Enterprise pricing is custom.

Q: Is there a setup fee?
A: Setup starts at €990 one-time and depends on the number of channels and integrations.

Q: Is there a free trial?
A: Yes, 14 days on Starter and Growth. No credit card required.

Q: Are prices including VAT?
A: Prices are net, excluding 19% German VAT.

Q: Can I cancel anytime?
A: Monthly plans can be cancelled at the end of any billing month.`,
  },
  {
    title: 'Support FAQ',
    sourceType: 'FAQ',
    text: `Q: The chat widget does not appear on my website.
A: Check that the embed script is placed before the closing </body> tag, that the data-bot-id matches your bot, and that your domain is listed under AI Agent → Allowed origins. Clear your cache and reload.

Q: How do I reset my password?
A: Use "Forgot password" on the sign-in page or ask a workspace owner to reset it.

Q: Which languages does the assistant support?
A: The assistant replies in the customer's language, including English, German, Persian, Spanish and French.

Q: Where is data hosted?
A: Customer data is hosted in Germany (Frankfurt region). NovaTech provides a data processing agreement (DPA) on request.

Q: Do you have an API?
A: Yes. A REST API and signed outbound webhooks are available on Growth and Enterprise.`,
  },
  {
    title: 'Opening hours',
    sourceType: 'MANUAL',
    text: `NovaTech support and sales are available Monday to Friday, 09:00–18:00 (Europe/Berlin). We are closed on weekends and German public holidays. Outside these hours the AI assistant is available 24/7 and the team follows up on the next business day.`,
  },
  {
    title: 'Contact information',
    sourceType: 'MANUAL',
    text: `NovaTech GmbH, Friedrichstraße 68, 10117 Berlin, Germany.
Sales: sales@novatech.example · +49 30 1234 5670
Support: support@novatech.example · +49 30 1234 5671
Managing directors: Lena Hoffmann. Registered at Amtsgericht Berlin-Charlottenburg.`,
  },
];

/** Product catalog: the only source of prices the AI may quote. */
export const PRODUCTS: {
  name: string;
  sku: string;
  category: string;
  description: string;
  price: number | null;
  priceNote: string | null;
  url?: string;
}[] = [
  { name: 'Starter', sku: 'BOT-STARTER', category: 'Chatbot plans', price: 149, priceNote: 'per month, net', description: 'AI chatbot for your website: up to 1,000 conversations per month, knowledge base, lead capture and human handoff. 14-day free trial.', url: 'https://novatech.example/pricing' },
  { name: 'Growth', sku: 'BOT-GROWTH', category: 'Chatbot plans', price: 399, priceNote: 'per month, net', description: 'Website + WhatsApp, up to 5,000 conversations per month, lead management, automations, REST API and webhooks. 14-day free trial.', url: 'https://novatech.example/pricing' },
  { name: 'Enterprise', sku: 'BOT-ENTERPRISE', category: 'Chatbot plans', price: null, priceNote: null, description: 'Unlimited conversations, SSO, custom integrations, dedicated success manager and SLA. Custom pricing from the sales team.' },
  { name: 'Chatbot setup', sku: 'SETUP', category: 'Services', price: 990, priceNote: 'one-time, starting at', description: 'Kickoff, knowledge-base setup, widget installation, WhatsApp verification and team training. Final price depends on channels and integrations.' },
  { name: 'Business website', sku: 'WEB-BUSINESS', category: 'Services', price: null, priceNote: null, description: 'Fast, accessible Next.js website with CMS and SEO basics. Quoted per project.' },
  { name: 'CRM integration', sku: 'INT-CRM', category: 'Services', price: null, priceNote: null, description: 'HubSpot, Pipedrive or Salesforce connection, or automations via Zapier, Make or n8n. Quoted per project.' },
];

export type Line = ['customer' | 'ai' | 'agent' | 'system', string];

export interface ScriptedConversation {
  customer: {
    name?: string;
    email?: string;
    phone?: string;
    company?: string;
    language: string;
    tags?: string[];
    summary?: string;
    note?: string;
  };
  channel: ChannelType;
  intent: Intent;
  daysAgo: number;
  status: ConversationStatus;
  /** Index into TEAM for the handling agent. */
  agent?: number;
  aiResolved?: boolean;
  handoff?: boolean;
  unread?: number;
  lead?: {
    status: LeadStatus;
    temperature: LeadTemperature;
    requestedService: string;
    message: string;
    preferredContact?: string;
    estimatedValue?: number;
  };
  ticket?: { subject: string; priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT'; status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' };
  summary?: string;
  /** Knowledge source the AI answered from (title); `null` = no verified answer existed. */
  source?: string | null;
  lines: Line[];
}

export const SCRIPTED: ScriptedConversation[] = [
  {
    customer: {
      name: 'Anna Schulz',
      email: 'anna.schulz@immo-schulz.example',
      company: 'Immobilien Schulz',
      language: 'en',
      tags: ['Pricing', 'Real estate'],
      summary:
        'Real-estate agency owner interested in Website + WhatsApp. About 200 inquiries per month. Asked about pricing and requested a demo. Email collected.',
    },
    channel: 'WEBSITE',
    intent: 'PRICING',
    daysAgo: 0,
    status: 'AI_ACTIVE',
    unread: 1,
    lead: {
      status: 'NEW',
      temperature: 'HOT',
      requestedService: 'AI chatbot – Website + WhatsApp',
      message: 'Real-estate agency, ~200 inquiries/month, wants a demo this week.',
      preferredContact: 'email',
      estimatedValue: 5778,
    },
    summary:
      'Customer is interested in Website + WhatsApp integration for a real-estate company. They have approximately 200 customer inquiries per month. They asked about pricing and requested a demo. Email collected.',
    lines: [
      ['customer', 'What does implementation cost?'],
      ['ai', 'Pricing depends mainly on the channels and integrations you need. I can give you a rough estimate. Will you mainly use the chatbot on your website, WhatsApp, or both?'],
      ['customer', 'Both. We are a real estate agency with around 200 inquiries a month.'],
      ['ai', 'Thanks! For website + WhatsApp at that volume, our **Growth** plan fits well: €399/month (net) for up to 5,000 conversations, including lead management. Setup starts at €990 one-time, depending on integrations. Would a short demo with our team be helpful?'],
      ['customer', 'Yes, a demo would be great. anna.schulz@immo-schulz.example'],
      ['ai', "Perfect, Anna — I've passed your demo request to our sales team, and they'll email you at anna.schulz@immo-schulz.example to find a time. Is there anything specific you'd like them to cover, for example CRM integration?"],
      ['customer', 'Do you integrate with our CRM? We use Pipedrive.'],
    ],
  },
  {
    customer: {
      name: 'Markus Brandt',
      phone: '+4915112345678',
      company: 'Brandt Logistik',
      language: 'de',
      tags: ['Enterprise'],
      summary: 'Logistics company, wants WhatsApp for driver and customer updates. Demo booked; in qualification with Jonas.',
    },
    channel: 'WHATSAPP',
    intent: 'DEMO',
    daysAgo: 2,
    status: 'HUMAN_ACTIVE',
    agent: 1,
    handoff: true,
    lead: {
      status: 'QUALIFIED',
      temperature: 'HOT',
      requestedService: 'WhatsApp automation + custom API integration',
      message: 'Logistics company, wants automated shipment status updates via WhatsApp.',
      preferredContact: 'phone',
      estimatedValue: 14500,
    },
    summary: 'Logistikunternehmen möchte Sendungsstatus per WhatsApp automatisieren. Demo gewünscht, an Vertrieb (Jonas) übergeben.',
    lines: [
      ['customer', 'Hallo, können wir eine Demo vereinbaren? Wir sind ein Logistikunternehmen.'],
      ['ai', 'Hallo! Sehr gerne. Damit unser Team die Demo gut vorbereiten kann: Geht es Ihnen eher um Kundenanfragen auf der Website, um WhatsApp – oder um beides?'],
      ['customer', 'Vor allem WhatsApp. Kunden fragen ständig nach dem Sendungsstatus.'],
      ['ai', 'Verstehe. Automatische Statusauskünfte per WhatsApp lassen sich über eine API-Anbindung an Ihr System umsetzen. Möchten Sie direkt mit unserem Vertrieb sprechen? Dann übergebe ich an einen Kollegen.'],
      ['customer', 'Ja, gerne.'],
      ['system', 'Conversation handed over to Jonas Weber'],
      ['agent', 'Hallo Herr Brandt, hier ist Jonas von NovaTech. Passt Ihnen Donnerstag um 10:00 Uhr für eine 30-minütige Demo?'],
      ['customer', 'Donnerstag 10 Uhr passt. Bitte schicken Sie mir eine Einladung.'],
      ['agent', 'Perfekt, die Einladung ist unterwegs. Bis Donnerstag!'],
    ],
  },
  {
    customer: { name: 'Priya Natarajan', email: 'priya@brightdental.example', company: 'Bright Dental', language: 'en', tags: ['Support'] },
    channel: 'WEBSITE',
    intent: 'SUPPORT',
    daysAgo: 1,
    status: 'CLOSED',
    aiResolved: true,
    lines: [
      ['customer', "Hi, our chat widget isn't showing on our website after we installed it."],
      ['ai', "Sorry about that! Let's check three things:\n1. The embed script is placed right before the closing `</body>` tag.\n2. The `data-bot-id` matches your bot.\n3. Your domain is listed under **AI Agent → Allowed origins**.\n\nAfter that, clear your cache and reload. Does it appear now?"],
      ['customer', 'The domain was missing in allowed origins. Works now, thanks!'],
      ['ai', 'Great to hear it works! Anything else I can help with?'],
    ],
  },
  {
    customer: {
      name: 'Kevin Albrecht',
      phone: '+4917698765432',
      language: 'en',
      tags: ['VIP'],
      note: 'Long-time Growth customer. Double charge confirmed by finance — refund issued on 2 Oct.',
    },
    channel: 'WHATSAPP',
    intent: 'COMPLAINT',
    daysAgo: 0,
    status: 'WAITING_FOR_AGENT',
    handoff: true,
    unread: 2,
    ticket: { subject: 'Customer charged twice for September invoice', priority: 'HIGH', status: 'OPEN' },
    lines: [
      ['customer', 'I have been charged TWICE this month. This is the second time this happens. Not acceptable.'],
      ['ai', "I'm really sorry about this — being charged twice is frustrating. Billing issues need to be checked by our team, so I've created a support ticket and requested a team member to take over. Someone will reply here shortly."],
      ['system', 'Human handoff requested · ticket created'],
      ['customer', 'How long will that take?'],
      ['customer', 'I need this fixed today.'],
    ],
  },
  {
    customer: { name: 'Lucía Fernández', email: 'lucia@tiendaverde.example', company: 'Tienda Verde', language: 'es' },
    channel: 'WEBSITE',
    intent: 'TECHNICAL',
    daysAgo: 4,
    status: 'HUMAN_ACTIVE',
    agent: 2,
    handoff: true,
    unread: 1,
    lead: {
      status: 'CONTACTED',
      temperature: 'WARM',
      requestedService: 'Chatbot + Shopify integration',
      message: 'Online shop, wants order-status answers from Shopify.',
      preferredContact: 'email',
    },
    lines: [
      ['customer', 'Hola, ¿el chatbot puede consultar el estado de pedidos en Shopify?'],
      ['ai', 'Hola Lucía. Actualmente no tenemos una integración nativa con Shopify; se puede conectar mediante Zapier o una integración API a medida. Como es una pregunta técnica, ¿quieres que te ponga en contacto con un compañero?'],
      ['customer', 'Sí, por favor.'],
      ['system', 'Conversation handed over to Sara Rahimi'],
      ['agent', '¡Hola Lucía! Soy Sara. ¿Cuántos pedidos al mes gestionáis aproximadamente?'],
      ['customer', 'Unos 1.500 pedidos al mes.'],
    ],
  },
  {
    customer: { language: 'fr' },
    channel: 'WEBSITE',
    intent: 'FAQ',
    daysAgo: 3,
    status: 'CLOSED',
    aiResolved: true,
    lines: [
      ['customer', 'Bonjour, quels sont vos horaires ?'],
      ['ai', "Bonjour ! Notre équipe est disponible du lundi au vendredi, de 9h à 18h (heure de Berlin). En dehors de ces horaires, je reste disponible 24h/24 et l'équipe vous répond le jour ouvré suivant."],
      ['customer', 'Merci !'],
    ],
  },
  {
    customer: { name: 'Reza Karimi', phone: '+4915223344556', language: 'fa' },
    channel: 'WHATSAPP',
    intent: 'FAQ',
    daysAgo: 5,
    status: 'CLOSED',
    aiResolved: true,
    lines: [
      ['customer', 'سلام، آیا دستیار شما به زبان فارسی هم جواب می‌دهد؟'],
      ['ai', 'سلام! بله، دستیار به زبان مشتری پاسخ می‌دهد، از جمله فارسی، آلمانی، انگلیسی، اسپانیایی و فرانسوی.'],
      ['customer', 'عالی، ممنون.'],
    ],
  },
  {
    customer: { name: 'Julia Meier', email: 'julia.meier@kanzlei-meier.example', company: 'Kanzlei Meier', language: 'de', tags: ['Pricing'] },
    channel: 'WEBSITE',
    intent: 'SALES',
    daysAgo: 9,
    status: 'CLOSED',
    aiResolved: true,
    lead: {
      status: 'PROPOSAL',
      temperature: 'WARM',
      requestedService: 'Website chatbot (Starter)',
      message: 'Law firm, wants website chat for appointment requests. DSGVO important.',
      preferredContact: 'email',
      estimatedValue: 2778,
    },
    lines: [
      ['customer', 'Wir sind eine Kanzlei. Wo werden die Daten gespeichert?'],
      ['ai', 'Alle Kundendaten werden in Deutschland (Region Frankfurt) gehostet, und wir stellen auf Anfrage einen Auftragsverarbeitungsvertrag (AVV) bereit. Planen Sie den Chat nur auf der Website?'],
      ['customer', 'Ja, nur Website. Was kostet das?'],
      ['ai', 'Für die Website eignet sich unser **Starter**-Paket: 149 € pro Monat (netto) für bis zu 1.000 Gespräche, plus einmalige Einrichtung ab 990 €. Soll ich Ihnen ein Angebot schicken lassen?'],
      ['customer', 'Ja bitte, an julia.meier@kanzlei-meier.example'],
      ['ai', 'Danke, Frau Meier! Ich habe Ihre Anfrage an unser Vertriebsteam weitergegeben – Sie erhalten das Angebot per E-Mail.'],
    ],
  },
  {
    customer: { name: 'Oliver Grant', email: 'oliver@grantfitness.example', company: 'Grant Fitness', language: 'en' },
    channel: 'WEBSITE',
    intent: 'DEMO',
    daysAgo: 16,
    status: 'CLOSED',
    aiResolved: true,
    lead: { status: 'WON', temperature: 'HOT', requestedService: 'Growth plan', message: 'Gym chain with 4 locations.', preferredContact: 'email', estimatedValue: 5778 },
    lines: [
      ['customer', 'Can I see a demo? We run 4 gyms and get lots of membership questions on WhatsApp.'],
      ['ai', "Absolutely! WhatsApp + website is exactly what our Growth plan covers. Could you share the best email to send a demo invite to?"],
      ['customer', 'oliver@grantfitness.example'],
      ['ai', "Thanks, Oliver — your demo request is with our sales team, and they'll email you shortly."],
    ],
  },
  {
    customer: { name: 'Hannah Vogel', email: 'h.vogel@vogel-design.example', company: 'Vogel Design', language: 'de' },
    channel: 'WEBSITE',
    intent: 'PRICING',
    daysAgo: 22,
    status: 'CLOSED',
    aiResolved: true,
    lead: { status: 'LOST', temperature: 'COLD', requestedService: 'Website development', message: 'Small studio, budget below Starter.', preferredContact: 'email' },
    lines: [
      ['customer', 'Was kostet eine neue Website?'],
      ['ai', 'Website-Projekte kalkulieren wir individuell, je nach Umfang. Ich kann gerne eine Anfrage an unser Team weitergeben – wie viele Seiten planen Sie ungefähr?'],
      ['customer', 'Ca. 5 Seiten. h.vogel@vogel-design.example'],
      ['ai', 'Danke! Unser Team meldet sich per E-Mail mit einem Angebot.'],
    ],
  },
  {
    customer: { name: 'Samuel Okafor', phone: '+4916055566677', company: 'Okafor Consulting', language: 'en' },
    channel: 'WHATSAPP',
    intent: 'CONTACT',
    daysAgo: 6,
    status: 'CLOSED',
    agent: 3,
    handoff: true,
    lines: [
      ['customer', 'Can I talk to a real person please?'],
      ['ai', "Of course! Our team is offline right now (Mon–Fri, 09:00–18:00 Berlin time). I've noted your request, and a colleague will reply here on the next business day. Is there anything I can help with in the meantime?"],
      ['customer', 'No, I will wait.'],
      ['system', 'Conversation handed over to Tom Becker'],
      ['agent', "Good morning Samuel, Tom here from NovaTech. How can I help?"],
      ['customer', 'We need help migrating our FAQ into the bot.'],
      ['agent', "Happy to help — I've sent you our import template by email. Just reply here if anything is unclear."],
    ],
  },
  {
    customer: { name: 'Elif Demir', email: 'elif@demir-bau.example', company: 'Demir Bau', language: 'de' },
    channel: 'WEBSITE',
    intent: 'SALES',
    daysAgo: 12,
    status: 'CLOSED',
    aiResolved: true,
    lead: { status: 'QUALIFIED', temperature: 'WARM', requestedService: 'Chatbot + HubSpot integration', message: 'Construction company, uses HubSpot.', preferredContact: 'phone', estimatedValue: 7200 },
    lines: [
      ['customer', 'Können Leads automatisch in HubSpot landen?'],
      ['ai', 'Ja, HubSpot gehört zu unseren Standard-Integrationen. Leads aus Chat und WhatsApp können automatisch als Kontakt angelegt werden. Darf unser Vertrieb Sie dazu kontaktieren?'],
      ['customer', 'Gerne, elif@demir-bau.example, am besten telefonisch.'],
      ['ai', 'Danke, Frau Demir! Unser Vertrieb meldet sich telefonisch bei Ihnen.'],
    ],
  },
];

/** Short exchanges used to give the dashboard realistic volume. */
export const SHORT_EXCHANGES: { lang: string; intent: Intent; q: string; a: string; source?: string }[] = [
  { lang: 'en', intent: 'FAQ', q: 'Do you offer a free trial?', a: 'Yes — a 14-day free trial on Starter and Growth, no credit card required.' , source: 'Pricing FAQ' },
  { lang: 'en', intent: 'FAQ', q: 'Which languages does the bot speak?', a: "It replies in the customer's language, including English, German, Persian, Spanish and French." , source: 'Services overview' },
  { lang: 'en', intent: 'PRICING', q: 'How much is the Growth plan?', a: 'Growth is €399 per month (net) and includes website + WhatsApp, up to 5,000 conversations, lead management and automations.' , source: 'Pricing FAQ' },
  { lang: 'en', intent: 'TECHNICAL', q: 'Do you have an API?', a: 'Yes — a REST API and signed webhooks are available on Growth and Enterprise.' , source: 'Services overview' },
  { lang: 'en', intent: 'SUPPORT', q: 'How do I reset my password?', a: 'Use "Forgot password" on the sign-in page, or ask a workspace owner to reset it for you.' , source: 'Support FAQ' },
  { lang: 'en', intent: 'FAQ', q: 'Is it GDPR compliant? Where is data stored?', a: 'Customer data is hosted in Germany (Frankfurt), and we provide a data processing agreement on request.' , source: 'Support FAQ' },
  { lang: 'en', intent: 'FAQ', q: 'Can I connect my existing WhatsApp number?', a: 'Yes, via the WhatsApp Business Platform. We guide you through the Meta verification during setup.' , source: 'Services overview' },
  { lang: 'de', intent: 'FAQ', q: 'Wie lange dauert die Einrichtung?', a: 'Eine typische Einführung dauert 1–2 Wochen – inklusive Wissensdatenbank, Widget, WhatsApp-Verifizierung und Schulung.' , source: 'Services overview' },
  { lang: 'de', intent: 'PRICING', q: 'Sind die Preise inkl. MwSt.?', a: 'Alle Preise verstehen sich netto, zzgl. 19 % MwSt.' , source: 'Pricing FAQ' },
  { lang: 'de', intent: 'FAQ', q: 'Kann ich monatlich kündigen?', a: 'Ja, Monatspläne sind zum Ende jedes Abrechnungsmonats kündbar.' , source: 'Pricing FAQ' },
  { lang: 'es', intent: 'FAQ', q: '¿Tienen prueba gratuita?', a: 'Sí, 14 días gratis en Starter y Growth, sin tarjeta de crédito.' , source: 'Pricing FAQ' },
  { lang: 'fr', intent: 'PRICING', q: 'Combien coûte le plan Starter ?', a: 'Le plan Starter coûte 149 € HT par mois, pour un maximum de 1 000 conversations.' , source: 'Pricing FAQ' },
  { lang: 'fa', intent: 'FAQ', q: 'ساعات کاری پشتیبانی چیست؟', a: 'پشتیبانی دوشنبه تا جمعه، ساعت ۹ تا ۱۸ به وقت برلین در دسترس است. خارج از این ساعات، دستیار هوش مصنوعی ۲۴ ساعته پاسخ می‌دهد.' , source: 'Opening hours' },
  { lang: 'en', intent: 'OTHER', q: 'hi', a: 'Hi there! 👋 How can I help you today?' },
];

/** Questions the knowledge base cannot answer yet (they show up as gaps in AI insights). */
export const GAP_EXCHANGES: { lang: string; intent: Intent; q: string }[] = [
  { lang: 'en', intent: 'TECHNICAL', q: 'How do I install the widget on Squarespace?' },
  { lang: 'en', intent: 'TECHNICAL', q: 'Is there an installation guide for WordPress?' },
  { lang: 'en', intent: 'SUPPORT', q: 'Can you send me the installation steps for our Wix site?' },
  { lang: 'en', intent: 'TECHNICAL', q: 'Installation on Shopify — where do I paste the code?' },
  { lang: 'en', intent: 'TECHNICAL', q: 'Do you integrate with Salesforce?' },
  { lang: 'en', intent: 'SALES', q: 'Is there a Salesforce integration for leads?' },
  { lang: 'de', intent: 'SUPPORT', q: 'Wie trage ich unsere USt-IdNr. auf der Rechnung ein?' },
  { lang: 'en', intent: 'SUPPORT', q: 'How can I add our VAT ID to the invoice?' },
];

export const GAP_ANSWER: Record<string, string> = {
  en: "I don't have verified information about that yet. Would you like me to connect you with our team?",
  de: 'Dazu habe ich leider noch keine verifizierten Informationen. Soll ich Sie mit unserem Team verbinden?',
};

