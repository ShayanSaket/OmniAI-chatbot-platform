import 'server-only';
import type { IntegrationType } from '@prisma/client';
import type { z } from 'zod';
import type { EventType } from '@/lib/events';
import type { EventPayload } from '../../events/payload';

// Integration abstraction. A connector turns OmniAI events into actions in an external
// system (CRM, e-commerce, calendar). Business logic never calls a provider directly:
// it emits domain events, and the integration consumer routes them to active connectors.
//
// To add a connector: implement IntegrationConnector, register it in registry.ts.

export interface ConnectorContext<Config, Secrets> {
  organizationId: string;
  integrationId: string;
  config: Config;
  secrets: Secrets;
}

export interface ConnectorTestResult {
  ok: boolean;
  /** Human-readable, e.g. "Connected to portal 12345". */
  detail: string;
}

export interface IntegrationConnector<Config = unknown, Secrets = unknown> {
  type: IntegrationType;
  name: string;
  description: string;
  category: 'crm' | 'automation' | 'commerce' | 'calendar' | 'custom';
  /**
   * available = connect here; webhook = use an outbound webhook with this preset;
   * planned = interface ready, connector not built yet.
   */
  status: 'available' | 'webhook' | 'planned';
  /** Events the connector reacts to. */
  events: EventType[];
  configSchema?: z.ZodType<Config, z.ZodTypeDef, unknown>;
  secretsSchema?: z.ZodType<Secrets, z.ZodTypeDef, unknown>;
  testConnection?(ctx: ConnectorContext<Config, Secrets>): Promise<ConnectorTestResult>;
  /** Handles one event; throw to record an error on the integration. */
  handleEvent?(ctx: ConnectorContext<Config, Secrets>, payload: EventPayload): Promise<string | null>;
}
