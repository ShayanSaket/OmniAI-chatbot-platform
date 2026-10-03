import type { Metadata } from 'next';
import { BehaviorSettings } from '@/components/agent/behavior-settings';
import { BusinessHoursEditor } from '@/components/agent/business-hours-editor';
import { EmbedCard } from '@/components/agent/embed-card';
import { ProductsManager } from '@/components/agent/products-manager';
import { PromptLayers } from '@/components/agent/prompt-layers';
import { ToolsSettings } from '@/components/agent/tools-settings';
import { WidgetSettings } from '@/components/agent/widget-settings';
import { PageHeader } from '@/components/common/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { parseAgentBehavior } from '@/lib/agent-tools';
import { hasPermission } from '@/lib/permissions';
import { requirePageAuth } from '@/server/auth/session';
import { resolveBot } from '@/server/channels/website/widget-auth';
import { env } from '@/server/env';
import { getPrimaryBot, listToolExecutions } from '@/server/modules/bot/bot-service';
import { getBusinessHours } from '@/server/modules/bot/business-hours-service';
import { listPromptLayers } from '@/server/modules/bot/prompt-service';
import { getOrderLookupSettings } from '@/server/modules/integrations/order-lookup-service';
import { listProducts } from '@/server/modules/products/product-service';
import { publicWidgetConfig } from '@/server/modules/widget/widget-service';

export const metadata: Metadata = { title: 'AI Agent' };

const TABS = ['widget', 'behavior', 'prompts', 'tools', 'products', 'hours'] as const;
type Tab = (typeof TABS)[number];

export default async function AgentPage({ searchParams }: { searchParams: { tab?: string } }) {
  const ctx = await requirePageAuth('bot:manage');
  const bot = await getPrimaryBot(ctx);
  const [resolved, layers, hours, products, orderLookup, executions] = await Promise.all([
    resolveBot(bot.publicKey),
    listPromptLayers(ctx),
    getBusinessHours(ctx),
    listProducts(ctx),
    getOrderLookupSettings(ctx),
    listToolExecutions(ctx, 25),
  ]);
  const appUrl = env().APP_URL.replace(/\/$/, '');
  const quickReplies = Array.isArray(bot.quickReplies) ? (bot.quickReplies as unknown[]).filter((q): q is string => typeof q === 'string') : [];
  const behavior = parseAgentBehavior(bot.behavior);
  const tab: Tab = TABS.includes(searchParams.tab as Tab) ? (searchParams.tab as Tab) : 'widget';

  // Base config for the live preview (team status etc.); form values override appearance.
  const base = resolved
    ? publicWidgetConfig(resolved)
    : {
        botKey: bot.publicKey,
        agentName: bot.agentName,
        companyName: bot.companyName,
        welcomeMessage: bot.welcomeMessage,
        primaryColor: bot.primaryColor,
        position: bot.widgetPosition === 'bottom-left' ? ('bottom-left' as const) : ('bottom-right' as const),
        avatarUrl: bot.avatarUrl,
        logoUrl: bot.logoUrl,
        quickReplies,
        allowAttachments: bot.allowAttachments,
        showSources: bot.showSourcesWebsite,
        defaultLanguage: bot.defaultLanguage,
        team: { online: true, nextOpenAt: null },
      };

  return (
    <>
      <PageHeader title="AI Agent" description={`Configure ${bot.agentName}: how it looks, what it knows, what it may do and when it hands over.`} />
      <Tabs defaultValue={tab} className="space-y-6">
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList>
            <TabsTrigger value="widget">Website widget</TabsTrigger>
            <TabsTrigger value="behavior">Behavior</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="hours">Business hours</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="widget" className="space-y-6">
          <EmbedCard appUrl={appUrl} botKey={bot.publicKey} active={bot.isActive} />
          <WidgetSettings
            base={base}
            appOrigin={new URL(appUrl).origin}
            initial={{
              isActive: bot.isActive,
              agentName: bot.agentName,
              welcomeMessage: bot.welcomeMessage,
              primaryColor: bot.primaryColor,
              widgetPosition: bot.widgetPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right',
              avatarUrl: bot.avatarUrl ?? '',
              quickReplies,
              allowAttachments: bot.allowAttachments,
              showSourcesWebsite: bot.showSourcesWebsite,
              allowedOrigins: bot.allowedOrigins.join('\n'),
            }}
          />
        </TabsContent>

        <TabsContent value="behavior">
          <BehaviorSettings
            initial={{
              agentName: bot.agentName,
              companyName: bot.companyName,
              businessDescription: bot.businessDescription,
              tone: bot.tone,
              customTone: bot.customTone ?? '',
              answerLength: bot.answerLength,
              creativity: bot.creativity,
              defaultLanguage: bot.defaultLanguage,
              model: bot.model,
              fallbackResponse: bot.fallbackResponse,
              escalationBehavior: bot.escalationBehavior,
              escalateOn: behavior.escalateOn,
              showSourcesWhatsapp: bot.showSourcesWhatsapp,
            }}
          />
        </TabsContent>

        <TabsContent value="prompts">
          <PromptLayers
            canEditPolicy={hasPermission(ctx.role, 'organization:manage')}
            layers={layers.map((l) => ({
              id: l.id,
              layer: l.layer,
              channel: l.channel === 'WEBSITE' || l.channel === 'WHATSAPP' ? l.channel : null,
              content: l.content,
              isActive: l.isActive,
              sortOrder: l.sortOrder,
              updatedAt: l.updatedAt.toISOString(),
            }))}
          />
        </TabsContent>

        <TabsContent value="tools">
          <ToolsSettings
            disabledTools={behavior.disabledTools}
            escalationDisabled={bot.escalationBehavior === 'DISABLED'}
            orderLookup={orderLookup}
            executions={executions}
          />
        </TabsContent>

        <TabsContent value="products">
          <ProductsManager products={products} />
        </TabsContent>

        <TabsContent value="hours">
          <BusinessHoursEditor initial={hours.hours} timeZone={hours.timeZone} canEditTimeZone={hasPermission(ctx.role, 'organization:manage')} />
        </TabsContent>
      </Tabs>
    </>
  );
}
