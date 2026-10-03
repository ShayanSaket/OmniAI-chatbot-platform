import 'server-only';
import { z } from 'zod';
import { isWithinBusinessHours, nextOpening } from '@/lib/business-hours';
import { searchKnowledge } from '../../knowledge/retrieval';
import { defineTool } from './types';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const searchKnowledgeBase = defineTool({
  name: 'search_knowledge_base',
  status: 'searching',
  description:
    'Search the company knowledge base (documents, FAQs, policies). Use it when the snippets already provided do not answer the question. Semantic + keyword search: phrase the query as a short question or key terms; if nothing is found, retry with synonyms. Returns numbered snippets; cite facts you use with their [ref] number.',
  parameters: z.object({
    query: z.string().trim().min(2).max(300).describe('Search terms or the question, in any language.'),
  }),
  async execute(ctx, { query }) {
    const results = await searchKnowledge(ctx.organizationId, query, { limit: 4 });
    if (!results.length) {
      return {
        results: [],
        note: "Nothing relevant found. Do not guess: say you don't have verified information on this and offer to connect the customer with the team.",
      };
    }
    return {
      results: results.map((r) => ({
        ref: ctx.knowledge.add(r),
        title: r.title,
        section: r.location,
        page: r.pageNumber,
        content: r.content,
      })),
    };
  },
});

function formatPrice(price: unknown, currency: string, note: string | null): string {
  if (price === null || price === undefined) return 'On request';
  const amount = Number(price);
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
  } catch {
    formatted = `${amount.toFixed(2)} ${currency}`;
  }
  return note ? `${formatted} ${note}` : formatted;
}

export const getProductInformation = defineTool({
  name: 'get_product_information',
  status: 'searching',
  description:
    'Look up products, plans and services in the official catalog, including prices. This is the only source of prices: never quote a price that is not returned here or in the knowledge base. Leave query empty to list everything.',
  parameters: z.object({
    query: z.string().trim().max(120).optional().describe('Product name, category or keywords. Omit to list all.'),
  }),
  async execute(ctx, { query }) {
    const terms = (query ?? '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    const products = await ctx.db.product.findMany({
      where: {
        isActive: true,
        ...(terms.length
          ? {
              OR: terms.flatMap((t) => [
                { name: { contains: t, mode: 'insensitive' as const } },
                { description: { contains: t, mode: 'insensitive' as const } },
                { category: { contains: t, mode: 'insensitive' as const } },
                { sku: { contains: t, mode: 'insensitive' as const } },
              ]),
            }
          : {}),
      },
      orderBy: [{ category: 'asc' }, { price: 'asc' }],
      take: 10,
    });
    if (!products.length) {
      return { products: [], note: 'No matching product in the catalog. Do not guess names or prices.' };
    }
    return {
      ...(products.some((p) => p.price === null)
        ? { note: 'Products priced "On request" have no list price: offer a quote from the sales team instead of naming a number.' }
        : {}),
      products: products.map((p) => ({
        name: p.name,
        sku: p.sku,
        category: p.category,
        description: p.description.slice(0, 500),
        price: formatPrice(p.price, p.currency, p.priceNote),
        url: p.url,
      })),
    };
  },
});

export const getBusinessHours = defineTool({
  name: 'get_business_hours',
  status: 'searching',
  description: 'Get the support team opening hours, whether the team is available right now and when it opens next.',
  parameters: z.object({}),
  async execute(ctx) {
    const now = new Date();
    const open = isWithinBusinessHours(ctx.businessHours, ctx.timeZone, now);
    const next = open ? null : nextOpening(ctx.businessHours, ctx.timeZone, now);
    const weekly = [1, 2, 3, 4, 5, 6, 0].map((weekday) => {
      const ranges = ctx.businessHours.filter((h) => h.weekday === weekday).map((h) => `${h.opensAt}–${h.closesAt}`);
      return { day: WEEKDAYS[weekday], hours: ranges.length ? ranges.join(', ') : 'closed' };
    });
    return {
      timeZone: ctx.timeZone,
      openNow: open,
      nextOpening: next
        ? new Intl.DateTimeFormat('en-GB', { timeZone: ctx.timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(next)
        : null,
      weekly,
      note: 'The AI assistant itself is available 24/7.',
    };
  },
});
