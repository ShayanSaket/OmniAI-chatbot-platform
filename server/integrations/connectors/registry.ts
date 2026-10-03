import 'server-only';
import type { IntegrationType } from '@prisma/client';
import { hubspotConnector } from './hubspot';
import type { IntegrationConnector } from './types';

// All known connectors. "webhook" connectors work today through signed outbound
// webhooks (with a preset); "planned" ones have their place in the abstraction but no
// implementation yet.

const planned = (type: IntegrationType, name: string, description: string, category: IntegrationConnector['category']): IntegrationConnector => ({
  type,
  name,
  description,
  category,
  status: 'planned',
  events: [],
});

const viaWebhook = (type: IntegrationType, name: string, description: string): IntegrationConnector => ({
  type,
  name,
  description,
  category: 'automation',
  status: 'webhook',
  events: [],
});

export const CONNECTORS: IntegrationConnector[] = [
  hubspotConnector as IntegrationConnector,
  planned('SALESFORCE', 'Salesforce', 'Create leads and contacts in Salesforce.', 'crm'),
  planned('PIPEDRIVE', 'Pipedrive', 'Create persons and deals in Pipedrive.', 'crm'),
  viaWebhook('ZAPIER', 'Zapier', 'Send OmniAI events to a Zapier “Catch Hook” and connect 6,000+ apps.'),
  viaWebhook('MAKE', 'Make', 'Send OmniAI events to a Make custom webhook scenario.'),
  viaWebhook('N8N', 'n8n', 'Send OmniAI events to an n8n Webhook node (cloud or self-hosted).'),
  planned('SHOPIFY', 'Shopify', 'Order status and product data from Shopify.', 'commerce'),
  planned('WOOCOMMERCE', 'WooCommerce', 'Order status and product data from WooCommerce.', 'commerce'),
  planned('STRIPE', 'Stripe', 'Payment status lookups for billing questions.', 'commerce'),
  planned('GOOGLE_CALENDAR', 'Google Calendar', 'Book confirmed appointments into a calendar.', 'calendar'),
  planned('OUTLOOK_CALENDAR', 'Outlook Calendar', 'Book confirmed appointments into a calendar.', 'calendar'),
];

export function getConnector(type: IntegrationType): IntegrationConnector | undefined {
  return CONNECTORS.find((c) => c.type === type);
}
