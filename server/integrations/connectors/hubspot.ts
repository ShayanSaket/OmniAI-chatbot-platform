import 'server-only';
import { z } from 'zod';
import { env } from '../../env';
import type { EventPayload } from '../../events/payload';
import { tenantDb } from '../../tenancy/tenant-db';
import type { IntegrationConnector } from './types';

// HubSpot CRM: creates or updates a contact (matched by email) when OmniAI captures a
// lead or a customer with an email address. Uses a HubSpot private-app access token
// with the crm.objects.contacts.read/write scopes.

export const hubspotConfigSchema = z.object({
  syncLeads: z.boolean().default(true),
  syncCustomers: z.boolean().default(false),
});
export const hubspotSecretsSchema = z.object({ accessToken: z.string().min(10) });
type Config = z.infer<typeof hubspotConfigSchema>;
type Secrets = z.infer<typeof hubspotSecretsSchema>;

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HubSpotError';
  }
}

async function hubspot<T>(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const base = env().HUBSPOT_API_URL.replace(/\/$/, '');
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      if (attempt === 3) throw new HubSpotError(`HubSpot unreachable: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const data = (await res.json().catch(() => null)) as { message?: string } | null;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === 3) {
      throw new HubSpotError(res.status === 401 ? 'HubSpot rejected the access token.' : `HubSpot error ${res.status}: ${data?.message ?? 'unknown'}`, res.status);
    }
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  throw new HubSpotError('HubSpot request failed');
}

function splitName(name: string | null | undefined) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstname: parts[0] ?? '', lastname: parts.slice(1).join(' ') };
}

export const hubspotConnector: IntegrationConnector<Config, Secrets> = {
  type: 'HUBSPOT',
  name: 'HubSpot',
  description: 'Create and update HubSpot contacts from leads and customers captured by the assistant.',
  category: 'crm',
  status: 'available',
  events: ['lead.created', 'customer.created'],
  configSchema: hubspotConfigSchema,
  secretsSchema: hubspotSecretsSchema,

  async testConnection({ secrets }) {
    await hubspot(secrets.accessToken, 'GET', '/crm/v3/objects/contacts?limit=1&properties=email');
    return { ok: true, detail: 'HubSpot accepted the access token (contacts readable).' };
  },

  async handleEvent({ config, secrets, organizationId }, payload: EventPayload) {
    const data = payload.data as { lead?: { email: string | null; name: string | null; phone: string | null; company: string | null; requestedService: string | null }; customer?: { id: string; email: string | null; name: string | null; phone: string | null; company: string | null } };
    const isLead = payload.type === 'lead.created';
    if (isLead && !config.syncLeads) return null;
    if (payload.type === 'customer.created' && !config.syncCustomers) return null;
    const person = isLead ? data.lead : data.customer;
    const email = person?.email ?? data.customer?.email;
    if (!email) return 'Skipped: no email address';

    const properties: Record<string, string> = {
      email,
      ...splitName(person?.name ?? data.customer?.name),
      ...(person?.phone ? { phone: person.phone } : {}),
      ...(person?.company ? { company: person.company } : {}),
      ...(isLead ? { lifecyclestage: 'lead', hs_lead_status: 'NEW' } : {}),
    };
    // Empty strings would overwrite existing HubSpot values: drop them.
    for (const k of Object.keys(properties)) if (!properties[k]) delete properties[k];

    const result = await hubspot<{ results: { id: string }[] }>(secrets.accessToken, 'POST', '/crm/v3/objects/contacts/batch/upsert', {
      inputs: [{ idProperty: 'email', id: email, properties }],
    });
    const contactId = result.results?.[0]?.id;
    const customerId = data.customer?.id;
    if (contactId && customerId) {
      const db = tenantDb(organizationId);
      const customer = await db.customer.findUnique({ where: { id: customerId }, select: { customFields: true } });
      if (customer) {
        await db.customer.update({
          where: { id: customerId },
          data: { customFields: { ...((customer.customFields ?? {}) as object), hubspotContactId: contactId } },
        });
      }
    }
    return `HubSpot contact ${contactId ?? '(unknown id)'} upserted`;
  },
};
