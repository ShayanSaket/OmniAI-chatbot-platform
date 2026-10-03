import 'server-only';
import { runAutomationsForEvent } from '../modules/automations/engine';
import { dispatchToIntegrations } from '../modules/integrations/integration-service';
import { enqueueWebhooksForEvent } from '../modules/webhooks/delivery';
import { registerEventConsumer } from './domain-events';

// Wires the event consumers. Imported lazily by dispatchEvent().
registerEventConsumer('webhooks', enqueueWebhooksForEvent);
registerEventConsumer('automations', runAutomationsForEvent);
registerEventConsumer('integrations', dispatchToIntegrations);
