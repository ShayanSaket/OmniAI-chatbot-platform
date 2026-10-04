# OmniAI — Architecture

Omnichannel AI customer-service platform: website live chat + WhatsApp, one shared AI
backend, one admin dashboard. This document is the design reference; it is updated as
phases land.

## 1. High-level architecture

```
 ┌──────────────┐   ┌──────────────┐            ┌───────────────────────────┐
 │ Website      │   │ WhatsApp     │  (future)  │ Instagram / Messenger /   │
 │ widget (JS)  │   │ Cloud API    │            │ Telegram / SMS / Email    │
 └──────┬───────┘   └──────┬───────┘            └────────────┬──────────────┘
        │ HTTPS + SSE       │ signed webhooks                 │
 ┌──────▼──────────────────▼─────────────────────────────────▼──────────────┐
 │                     Channel adapters (server/channels)                    │
 │  normalizeIncoming() · sendMessage() · handleStatusUpdate()               │
 └──────────────────────────────┬────────────────────────────────────────────┘
                                │ NormalizedInboundMessage
 ┌──────────────────────────────▼────────────────────────────────────────────┐
 │                 Message pipeline (server/modules/chat)                    │
 │ org → customer → store → conversation → memory → intent → handoff check   │
 │ → RAG retrieve → tools → LLM → guardrails → store → dispatch → analytics  │
 └───────┬──────────────┬──────────────┬──────────────┬──────────────────────┘
         │              │              │              │
   ┌─────▼────┐  ┌──────▼─────┐  ┌─────▼──────┐  ┌────▼───────────┐
   │ AI agent │  │ Knowledge  │  │ Tool       │  │ Automations /  │
   │ (OpenAI) │  │ (pgvector) │  │ registry   │  │ outbound hooks │
   └──────────┘  └────────────┘  └────────────┘  └────────────────┘
         │              │              │              │
 ┌───────▼──────────────▼──────────────▼──────────────▼──────────────────────┐
 │ PostgreSQL 16 + pgvector (Prisma)  ·  Redis (rate limits, queues, pub/sub)│
 │ S3-compatible storage (uploads; SeaweedFS locally, any S3 in production)  │
 └───────────────────────────────────────────────────────────────────────────┘
                                ▲
 ┌──────────────────────────────┴────────────────────────────────────────────┐
 │ Admin dashboard (Next.js App Router, server components + route handlers)  │
 └───────────────────────────────────────────────────────────────────────────┘
```

Single deployable Next.js 14 application (App Router). Business logic lives in
`server/` modules, not in route files; route handlers are thin (auth → validate →
call service → serialize). A separate worker process can later consume the same
modules for queue jobs (embedding, webhook delivery, summaries) without restructuring.

## 2. Folder structure

```
app/
  (auth)/login, (auth)/register        public auth pages
  (dashboard)/<section>/page.tsx       authenticated admin UI (server components)
  api/auth/[...nextauth]               Auth.js
  api/v1/...                           REST API (thin handlers)
  api/health                           liveness/readiness
components/
  ui/                                  shadcn/ui primitives
  layout/  dashboard/  settings/  auth/  common/
lib/                                   client-safe shared code (permissions, utils, types)
server/                                server-only code (imports "server-only")
  env.ts  db.ts  logger.ts  errors.ts  http.ts  crypto.ts  rate-limit.ts
  auth/        Auth.js options, session + role guards, password hashing
  tenancy/     tenant-scoped Prisma client (organizationId injection)
  modules/     one folder per domain: organizations, team, audit, analytics, bot,
               chat (pipeline, responder, handoff), widget, ai (prompt builder);
               later knowledge, customers, leads, tickets, automations, integrations
  channels/    ChannelAdapter interface, registry, website adapter (WhatsApp in phase 5)
  ai/          provider-neutral ChatProvider + OpenAI-compatible streaming client, pricing
  realtime/    pub/sub bus (Redis, in-process fallback) + SSE response helper
  storage/     S3 client, content-sniffed uploads, signed download URLs
components/widget/   the chat widget UI (runs inside the iframe)
public/chat-widget.js  the embed loader (vanilla JS, no dependencies)
prisma/  schema.prisma, migrations/, seed.ts
tests/   unit/ and integration/
docker-compose.yml  Dockerfile  .env.example  middleware.ts
```

## 3. Database

PostgreSQL 16 with `pgvector`. Prisma schema: `prisma/schema.prisma`.

* Every tenant-owned table has `organizationId` with a leading composite index.
* `server/tenancy/tenant-db.ts` returns a Prisma client extension that injects
  `organizationId` into every `where`/`data` for tenant models, so a forgotten filter
  cannot leak data across organizations (defence in depth on top of explicit filters).
* Users are global; `Membership` links users to organizations with a `Role`.
* `Message (channel, externalMessageId)` is unique and `InboundWebhookEvent
  (provider, eventId)` is unique → idempotent webhook processing.
* Embeddings are stored inline on `KnowledgeChunk.embedding vector(1536)` (HNSW index);
  `EmbeddingCache (model, contentHash)` avoids re-embedding identical text.
* Secrets stored in the DB (per-org WhatsApp tokens, webhook signing secrets,
  integration credentials) are AES-256-GCM encrypted with `ENCRYPTION_KEY`.

## 4. Main API contracts (v1)

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | public | create user + organization (OWNER) |
| GET/PATCH | `/api/v1/organization` | OWNER (write) | organization profile |
| GET/POST | `/api/v1/team` | ADMIN | list / add members |
| PATCH/DELETE | `/api/v1/team/:membershipId` | ADMIN (OWNER for admins) | change role / remove |
| GET | `/api/v1/analytics/overview?range=` | ADMIN | dashboard KPIs |
| GET | `/api/v1/analytics/report?range=today\|7d\|30d\|90d` or `?range=custom&from&to` | ADMIN | full analytics with previous-period comparison |
| GET/POST | `/api/v1/analytics/insights` | ADMIN | knowledge gaps, FAQs, complaints, intent trends / write an AI insight report |
| GET | `/api/v1/analytics/export` | ADMIN | daily (or hourly) metrics as CSV |
| GET/PATCH | `/api/v1/bot` | ADMIN | widget appearance, identity, tone, escalation, tool switches (partial `behavior` is merged) |
| GET/POST | `/api/v1/bot/prompts` | ADMIN (global policy: OWNER) | prompt layers |
| PATCH/DELETE | `/api/v1/bot/prompts/:layerId` | ADMIN (global policy: OWNER) | edit / remove a layer |
| GET | `/api/v1/bot/prompt-preview?channel=` | ADMIN | composed system prompt + enabled tools |
| GET | `/api/v1/bot/tool-executions` | ADMIN | recent AI tool calls |
| GET/POST | `/api/v1/knowledge` | ADMIN | list sources + stats / upload a file (multipart) |
| POST | `/api/v1/knowledge/website` · `/faq` · `/text` | ADMIN | add a web page (optional crawl), FAQ entries, text |
| GET/PATCH/DELETE | `/api/v1/knowledge/:documentId` | ADMIN | passages + download link / edit FAQ or text / delete |
| POST | `/api/v1/knowledge/:documentId/reindex` | ADMIN | re-extract + re-embed (refetches web pages) |
| POST | `/api/v1/knowledge/search` | ADMIN | retrieval tester |
| GET/POST | `/api/v1/automations` | ADMIN | list (+ builder options) / create |
| PUT/PATCH/DELETE | `/api/v1/automations/:id` | ADMIN | update / toggle `{ isActive }` / delete |
| GET | `/api/v1/automations/:id/runs` | ADMIN | run history with per-action results |
| GET/POST | `/api/v1/webhooks` | OWNER | endpoints / create (returns the signing secret once) |
| GET/PATCH/DELETE | `/api/v1/webhooks/:id` | OWNER | delivery log / update or enable / delete |
| POST | `/api/v1/webhooks/:id/test` · `/rotate-secret` | OWNER | signed ping / new secret |
| POST | `/api/v1/webhook-deliveries/:id/redeliver` | OWNER | send a failed delivery again |
| GET | `/api/v1/integrations` | OWNER | connectors and connection state |
| PUT/PATCH/POST/DELETE | `/api/v1/integrations/hubspot` | OWNER | connect (verified) / options / test / disconnect |
| GET/PATCH | `/api/v1/notifications` | any member | own notifications / mark read |
| GET/PUT | `/api/v1/business-hours` | ADMIN | weekly schedule (PUT replaces all ranges) |
| GET/POST | `/api/v1/products` | ADMIN | product / price catalog |
| PATCH/DELETE | `/api/v1/products/:productId` | ADMIN | edit / remove a product |
| GET/PUT/DELETE | `/api/v1/integrations/order-lookup` | read ADMIN, write OWNER | order-status connection (key encrypted, never returned) |
| POST | `/api/v1/integrations/order-lookup/test` | OWNER | test the connection with a real order |
| GET | `/api/widget/:botKey/config` | public | public widget config (no prompts/secrets) |
| POST | `/api/widget/:botKey/session` | public, origin-checked | start/resume visitor → visitor token |
| POST | `/api/widget/:botKey/messages` | visitor token | send message → **SSE** stream of the AI reply |
| GET | `/api/widget/:botKey/messages?after=` | visitor token | history catch-up |
| GET | `/api/widget/:botKey/events` | visitor token | long-lived **SSE** (agent messages, status) |
| POST | `/api/widget/:botKey/handoff` | visitor token | request a human |
| POST | `/api/widget/:botKey/conversation/restart` | visitor token | close and start over |
| POST | `/api/widget/:botKey/uploads` | visitor token | multipart upload → signed receipt |
| GET | `/api/files?k&e&s` | signed URL | sandboxed file download |
| GET/POST | `/api/webhooks/whatsapp` | verify token / Meta signature | verification handshake / inbound messages + statuses |
| GET/PUT/DELETE | `/api/v1/channels/whatsapp` | read ADMIN, write OWNER | WhatsApp connection status, connect, disconnect |
| POST | `/api/v1/channels/whatsapp/test` | ADMIN | verify credentials with Meta |
| GET/POST | `/api/v1/channels/whatsapp/templates` | ADMIN | list / sync message templates |
| GET/POST | `/api/v1/conversations/:id/whatsapp-template` | AGENT | 24-hour window state + sendable templates / send an approved template |
| GET | `/api/v1/conversations?status&channel&mode&assignee&unread&q&cursor` | AGENT | unified inbox list + counts |
| GET | `/api/v1/conversations/:id` | AGENT | thread, customer profile, summary, leads, tickets, notes, WhatsApp window |
| GET/POST | `/api/v1/conversations/:id/messages` | AGENT | older (`?before=`) / newer (`?after=`) messages / team reply on the original channel (idempotent `clientMessageId`) |
| POST | `/api/v1/conversations/:id/messages/:messageId/retry` | AGENT | resend a failed outgoing message |
| POST | `/api/v1/conversations/:id/take-over` · `/return-to-ai` · `/close` · `/reopen` · `/read` · `/typing` · `/summary` | AGENT | conversation state and read state |
| PUT | `/api/v1/conversations/:id/assign` | AGENT (self) / ADMIN (anyone) | assign or unassign |
| POST | `/api/v1/conversations/:id/suggestions` | AGENT | AI draft: generate, shorten, friendlier, professional, translate (never sends) |
| POST | `/api/v1/conversations/:id/uploads` | AGENT | multipart upload for a reply → signed receipt |
| POST/DELETE | `/api/v1/customers/:id/notes(/:noteId)` | AGENT (delete own; ADMIN any) | internal customer notes |
| GET | `/api/v1/inbox/events` | AGENT | live **SSE** inbox feed (ids only) |
| DELETE | `/api/v1/conversations/:id` | ADMIN | delete a conversation with messages and files (GDPR) |
| GET | `/api/v1/customers?q&type&channel&tag&sort&cursor` | AGENT | customer list |
| GET/PATCH/DELETE | `/api/v1/customers/:id` | AGENT read · ADMIN write/delete | profile / edit details + custom fields / erase (GDPR) |
| PUT | `/api/v1/customers/:id/tags` | ADMIN | replace tags by name |
| POST | `/api/v1/customers/:id/merge` | ADMIN | merge `{ sourceId }` into this customer |
| GET | `/api/v1/customers/:id/export` | ADMIN | GDPR export (JSON download) |
| GET · PATCH/DELETE | `/api/v1/tags` · `/api/v1/tags/:id` | AGENT · ADMIN | tags with counts / rename, recolor, delete |
| PATCH | `/api/v1/tickets/:id` · `/api/v1/appointments/:id` | ADMIN | status / priority / confirmed time |
| GET/POST | `/api/v1/leads?view=board&status&temperature&source&assignee&q` | ADMIN | pipeline board or list (+ stats) / create a lead |
| GET/PATCH/DELETE | `/api/v1/leads/:id` | ADMIN | lead with activity / update (stage, owner, value, …) / delete |
| GET | `/api/v1/leads/export` | ADMIN | CSV export of the filtered leads |

Error envelope: `{ "error": { "code": "FORBIDDEN", "message": "...", "requestId": "..." } }`.
List endpoints use cursor pagination: `?cursor=&limit=` → `{ data, nextCursor }`.

## 5. Website widget (phase 2)

```
 customer site                         OmniAI origin
 ┌──────────────────────────┐   iframe  ┌───────────────────────────────────┐
 │ <script chat-widget.js>  │──────────▶│ /widget/:botKey (React widget)    │
 │  · injects 1 iframe      │◀─────────▶│  · same-origin fetch to /api/widget│
 │  · stores visitor token  │ postMessage│  · SSE: reply stream + events     │
 │    (first-party storage) │ (origin-   └───────────────────────────────────┘
 │  · window.OmniAI API     │  checked)
 └──────────────────────────┘
```

* **Isolation:** the widget lives in an iframe, so host CSS/JS can't break it and it can't
  touch the host page. The loader only sizes the iframe (launcher, teaser, panel,
  expanded, mobile full screen) based on messages from the widget.
* **Embedding control:** the widget only starts a session after the loader's `init`
  message; the session API checks the browser-verified `event.origin` against the bot's
  allowed origins (wildcards supported, app origin always allowed).
* **Visitor identity:** HMAC-signed token binding (bot, customer) — cannot be forged or
  replayed against another bot. Stored by the loader in the host site's localStorage
  (third-party storage in iframes is partitioned/blocked).
* **Streaming:** `POST /messages` answers with SSE (stored message → `assistant.delta`… →
  stored reply). Generation continues and is stored even if the visitor disconnects.
  A long-lived `/events` stream (Redis pub/sub) delivers messages from other tabs, team
  replies, status changes (who joined) and "agent is typing"; on reconnect the widget
  catches up via `?after=`.
* **Idempotency:** client message ids → `Message.externalMessageId` (scoped per customer);
  retries replay the stored result instead of generating twice.
* **Files:** type detected from content (magic bytes; SVG/HTML/executables rejected),
  stored in S3 under the customer's prefix, attached only with a signed upload receipt,
  served through expiring signed URLs with a sandboxing CSP.
* **Handoff:** within business hours → `WAITING_FOR_AGENT` and the AI stops; outside →
  the AI keeps helping and the visitor is told when the team is back (localized).
* **UI:** streaming markdown (safe renderer, no HTML), quick replies, actions, link
  buttons, attachments, read ticks, day separators, typing indicator, reconnect banner,
  teaser, unread badge, expand, restart; en/de/fa/es/fr with RTL for Persian.

## 6. AI agent architecture (phase 3)

**Pipeline** (`server/modules/chat/pipeline.ts`, shared by all channels):

```
store message (idempotent) → language detection → intent classification (runs in parallel)
→ human-mode check → memory + customer profile + knowledge retrieval → agent loop (tools)
→ output guardrails → store reply (+ sources, linked ToolExecutions) → escalation rules
→ deliver via channel adapter → background summary / long-term memory
```

* **Prompt** (`modules/ai/prompt-builder.ts`, pure): global policy → identity (bot fields +
  layer) → personality/tone/length → channel layer → business rules → context (time, team
  status, customer profile and memory, open leads/tickets/appointments) → conversation
  summary → numbered knowledge snippets → tool rules → citation rules → per-turn security
  notice. Layers live in `PromptConfiguration`. The global policy applies to the whole
  organization and only owners can change it.
* **Agent loop** (`modules/agent/agent-runner.ts`): text streams to the customer. When the
  model proposes tool calls, the backend validates the input (Zod), checks the tool is
  enabled, runs it for the current conversation's customer only, records a `ToolExecution`
  and returns the result to the model. At most 4 rounds and 6 calls; the last round has no
  tools, so it always ends with an answer. The widget shows "Looking that up…" or
  "Working on it…" while a tool runs.
* **Tools** (`modules/agent/tools/`, catalog in `lib/agent-tools.ts`):
  - Knowledge: search_knowledge_base, get_product_information, get_business_hours
  - Customer: get_customer_profile, update_customer_profile
  - Sales and support: create_lead, create_support_ticket, schedule_appointment (a request
    only; the team confirms it), get_order_status (needs the order-lookup connection)
  - Escalation: request_human_agent, save_conversation_summary

  To add a tool: `defineTool()`, then a registry entry and a catalog entry. Any email or
  phone number passed to a tool must appear in the customer's own messages or already be
  on file, so the model cannot save invented contact details.
* **Understanding** (`modules/agent/classifier.ts`, `signals.ts`): the LLM classifies each
  message in JSON mode: intent, sentiment, lead temperature, escalation category, explicit
  request for a person, and language. A multilingual keyword heuristic is the fallback.
  The result is stored on the message and on the conversation. The conversation keeps its
  most significant intent, and its lead temperature only goes up.
* **Escalation** (`escalation.ts`):
  - `SUGGEST` adds a "Talk to a human" button, `AUTOMATIC` hands over, `DISABLED` never
    escalates.
  - The triggers (angry, complaint, legal, payment, technical, safety) are configurable.
  - A direct request for a person always hands over, unless escalation is disabled.
  - The model can also call `request_human_agent`.
* **Memory** (`memory.ts`):
  - The model receives the last 12 messages, plus the latest summary when the conversation
    is longer than that.
  - A rolling `ConversationSummary` is written every 12 messages, at handoff, and when the
    visitor restarts.
  - Summaries fold durable facts into `Customer.memory` and `Customer.aiSummary`, which
    later conversations receive.
  - Without a provider no summary is written; none is faked.
* **Language**: detected for each message (`lib/language.ts`). A confident detection
  updates the customer, so replies and system notices follow when the customer switches
  language.
* **Guardrails** (`guardrails.ts`):
  - Input: prompt-injection detection (en/de/es/fr/fa) adds a security notice for that turn.
  - Secrets: secret values and key-shaped strings in the reply are redacted.
  - Prompt leaks: a reply that reproduces the protected layers word for word is replaced
    with a localized refusal.
  - Contact details: emails and phone numbers that weren't in the context the model saw
    are redacted.
  - Every guard action is recorded as a flag in the message metadata.
* **Sources**: the model cites snippets as `[n]`. The markers are filtered out of the
  stream. The cited documents become `Message.sources`, which the widget shows when
  enabled, and each one increments `KnowledgeDocument.usageCount`.
* **Cost**: every chat, classification and summary call writes a `UsageRecord`.

## 7. Channel architecture (phases 2 and 5)

```ts
interface ChannelAdapter {
  readonly type: ChannelType
  readonly capabilities: { streaming, quickReplies, buttons, attachments, markdown, sources }
  normalizeIncomingMessage(raw): NormalizedInboundMessage[]
  sendMessage(conversation, message): Promise<DeliveryResult>
}
```
Adapters are registered in `server/channels/registry.ts`. Both channels feed the same
`processInboundMessage()` pipeline, and replies, handoff notices and agent messages
leave through `getChannelAdapter(channel).sendMessage()`.

**Website** (`channels/website/`): SSE fan-out via the Redis pub/sub bus (section 5).

**WhatsApp** (`channels/whatsapp/`):

```
Meta ──POST /api/webhooks/whatsapp──▶ verify X-Hub-Signature-256 (app secret)
  → split into events (one per message / per status transition)
  → INSERT InboundWebhookEvent ON CONFLICT DO NOTHING   (idempotency: wamid)
  → 200 OK immediately → background processing:
      claim with a 5-min lease → route by phone_number_id → tenant
      message: lock per sender → customer by wa_id (or an existing customer with that
               phone) → mark read + typing → media download, type check, S3 →
               voice note transcription → pipeline (same AI as website)
      status:  sent → delivered → read, monotonic; failed → errorCode
  → PROCESSED / IGNORED (payload cleared) or FAILED + backoff 30s, 2m, 10m, 30m
```

* **Outbound** (`outbound.ts`):
  - Markdown is converted to WhatsApp formatting, and text is split at 4,096 characters
    (1,024 for interactive messages).
  - "Talk to a human" and quick replies become reply buttons (at most 3, titles cut to 20
    characters); a single link becomes a `cta_url` button.
  - Attachments are uploaded through the media API.
  - The send records the wamid. Transient errors (429, 5xx, rate-limit codes) retry
    three times within the request, then in the background at 1, 5, 15 and 60 minutes.
    Parts of a multi-part message that were already sent are never resent.
* **24-hour window**: free-form messages are refused (`whatsapp_window_closed`) before
  calling Meta when the customer's last message is more than 24 hours old. Approved
  templates (`WhatsAppTemplate`, synced from Meta) are the way to re-engage.
* **Background jobs** (`server/jobs/`, started by `instrumentation.ts`): webhook event
  retries (every 15 s), delivery retries (every 30 s), and purging handled events after
  30 days. Each job takes a Redis lock, so only one instance runs it at a time.
  `DISABLE_JOBS=true` turns the jobs off for a separate worker.
* **Credentials**: the app secret, verify token and default access token come from the
  environment. A workspace can store its own access token, encrypted. Tokens are never
  returned to the browser.

## 8. RAG flow (phase 4)

**Ingestion** (`modules/knowledge/ingest.ts`, runs in the background after each add):

```
PDF (unpdf, per page) · DOCX (mammoth → HTML) · TXT/MD · web page (Readability) · FAQ · text
  → clean   (dehyphenate, unwrap lines, drop repeated headers/footers and page numbers)
  → chunk   (~900 chars, heading path as location, page number, one chunk per FAQ pair,
             one-block overlap)
  → embed   ("title › section" + text; OpenAI-compatible /embeddings, 1536 dims,
             sha256 cache in EmbeddingCache, so identical text is never paid twice)
  → store   (KnowledgeChunk + vector, HNSW index) → READY
```

* **Failure handling:**
  - Content problems mark the document FAILED with a clear message (password-protected
    or scanned PDF, empty page, blocked by robots.txt, HTTP 404).
  - Transient problems (DNS, timeouts, 5xx/429, crashes) go back to PENDING. The
    `knowledge-recover` job retries up to 3 times and also picks up documents stuck in
    PROCESSING.
  - Without an embedding provider, or when it fails, documents are still READY and
    keyword-searchable. The `knowledge-embedding-backfill` job adds vectors later, also
    after the embedding model changes.
* **Websites** (`web.ts`): fetched through `safeFetch` (SSRF rules on every redirect
  hop, size and time limits), `robots.txt` honored. The optional crawl adds same-site
  pages linked from the start page, up to 25.
* **Uploads**: PDF, DOCX, TXT and MD only, checked by magic bytes; up to 20 MB;
  duplicates are rejected by content hash. Originals are kept in S3 under
  `org/{org}/knowledge/{doc}/` and deleted together with the document.

**Retrieval** (`retrieval.ts`, `searchKnowledge()`), run for every customer message
and by the `search_knowledge_base` tool:

```
semantic: query embedding → pgvector cosine (HNSW, iterative scan, org filter), similarity ≥ 0.32
keyword:  Postgres FTS ('simple' config, prefix terms), term coverage ≥ 34%
  → Reciprocal Rank Fusion → at most 2 passages per document → top 4
```

* The query is only embedded when the organization has semantic vectors for the
  current model.
* Results carry document, section, page, score, similarity and which retriever matched
  (shown in the dashboard's "Test a question").
* Nothing above the thresholds means no snippets, and the assistant says it has no
  verified information (and can offer a human).
* Each AI message stores retrieval statistics (`metadata.retrieval`) for the
  knowledge-gap analytics planned for phase 8.

## 8b. Events, automations, webhooks and integrations (phase 9)

**Domain events** (`server/events/`) are announced at the place where things happen:

| Event | Emitted by |
|---|---|
| `conversation.created`, `message.received` | the pipeline |
| `customer.created` | widget session start, WhatsApp |
| `conversation.closed` | the widget restart, the inbox |
| `lead.created`, `ticket.created`, `appointment.requested` | AI tools, automation actions, the leads page |
| `lead.status_changed` | the leads page (`data: { from, to }`) |
| `human_handoff.requested` | `requestHumanHandoff` |
| `intent.detected` | classification |
| `conversation.inactive` | jobs |

Three consumers receive every event, each isolated from the others' failures:

```
emitDomainEvent ─┬─ webhooks      one WebhookDelivery per subscribed endpoint → signed POST
                 ├─ automations   matching trigger + conditions → actions (AutomationRun)
                 └─ integrations  active connectors (HubSpot) → handleEvent
```

* **Webhooks** (`modules/webhooks/`):
  - Payload: `{ id, type, apiVersion, createdAt, organizationId, data: { conversation, customer, message, lead, ticket, … } }`.
  - Headers: `X-OmniAI-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")` (receivers check it with a 5-minute tolerance), plus `X-OmniAI-Event`, `X-OmniAI-Event-Id` (stable across retries) and `X-OmniAI-Delivery`.
  - Retries at 30 s, 2 min, 10 min, 1 h and 6 h. A 410 response, or 10 deliveries in a row that fail permanently, disables the endpoint and notifies the owners.
  - SSRF-protected POST: no redirects, 10 s timeout. Secrets are encrypted and shown once; they can be rotated.
  - Endpoints are owner-only, because they are data egress.
* **Automations** (`modules/automations/`):
  - Triggers: CONVERSATION_CREATED, MESSAGE_RECEIVED, WHATSAPP_MESSAGE_RECEIVED, KEYWORD_DETECTED (whole words), INTENT_DETECTED, LEAD_CREATED, HANDOFF_REQUESTED, CONVERSATION_INACTIVE (a 1-minute scan with a per-automation threshold, once per quiet period).
  - Conditions: channels, keywords, intents, team status.
  - Actions: SEND_MESSAGE (with `{{variables|fallback}}`), CREATE_LEAD, ADD_TAG, ASSIGN_AGENT (fixed or round-robin), CREATE_TICKET, TRIGGER_WEBHOOK, NOTIFY_TEAM (in-app notifications), REQUEST_HANDOFF.
  - Each automation runs once per event (`AutomationRun` is unique on automation + event).
  - Automations for `conversation.created` and `message.received` run before the AI answers. A handoff decided by an automation therefore stops the AI reply.
  - Loop protection: an automation never reacts to events its own actions caused, and chains stop after 3 automations.
  - Failing actions are isolated and recorded per action.
* **Integrations** (`integrations/connectors/`): the `IntegrationConnector` interface
  (category, events, config and secret schemas, `testConnection`, `handleEvent`). HubSpot
  is implemented (contact upsert by email on `lead.created`, optionally on
  `customer.created`). Zapier, Make and n8n use webhook presets. Salesforce, Pipedrive,
  Shopify, WooCommerce, Stripe and the calendars are registered as planned.

## 8c. Unified inbox and human handoff (phase 6)

`server/modules/inbox/` serves the inbox; `components/inbox/` is the three-pane UI
(list · thread · customer panel; list ↔ thread on phones).

* **State machine:** `AI_ACTIVE → WAITING_FOR_AGENT` (handoff with the team online) →
  `HUMAN_ACTIVE` (take over, or simply reply) → `AI_ACTIVE` (return to AI) or `CLOSED`
  (close; reopen goes back to `HUMAN_ACTIVE`). The pipeline answers only `AI_ACTIVE`
  conversations, so the AI is silent as soon as a person is involved.
* **Takeover is race-safe:** an `updateMany` guarded by the previous status and assignee;
  of two simultaneous takeovers exactly one wins. Agents cannot take over or hand back a
  conversation another person handles (admins can). Any agent may still reply.
* **Replies go out on the original channel** through the channel adapter: website →
  visitor SSE (with the agent's name), WhatsApp → Graph API (formatting, 24-hour window,
  retries; a template dialog covers the closed window). Join / back-to-AI / closed notices
  are sent in the customer's language; on WhatsApp they are skipped outside the window.
* **Realtime:** `appendMessage` and every state change publish id-only events on
  `inbox:<orgId>`; `/api/v1/inbox/events` streams them, and the client refetches what
  changed (debounced) and catches up after reconnects.
* **Read state:** opening a conversation clears `unreadCount` and marks customer messages
  `READ`; replying does too.
* **Assignment:** agents assign themselves, admins anyone; history in
  `ConversationAssignment`; the assignee is notified. Handoff requests notify the
  assignee, or the whole team.
* **Suggested replies** (`suggestions.ts`): drafts from the last 20 messages, the summary,
  customer facts, matching knowledge excerpts and the product list, in the customer's
  language, with `[placeholders]` instead of invented facts. Rewrite actions keep facts and
  placeholders. Suggestions only fill the composer; usage is recorded as `SUGGESTION`.
* **Summary and notes:** the latest `ConversationSummary` (refreshable) and the customer's
  long-term facts sit next to the thread, with internal `CustomerNote`s that never reach
  the customer.

## 8d. Customers and leads (phase 7)

* **Profiles** (`modules/customers/`): contact details, language, tags, custom fields
  (≤ 30 string fields), channel identities, conversation / lead / ticket / appointment
  history, notes and the AI summary + long-term memory. Edits are audited by field name
  only, so the audit log never becomes a copy of personal data.
* **Merging is safe by design.** Website visitors start anonymous. A WhatsApp number is
  verified by the channel, so a website profile with that number is linked automatically
  when the person writes on WhatsApp. Contact details *typed* in a chat are not verified:
  linking them automatically would let anyone read someone else's history by typing their
  email. They only mark the profile as a **possible duplicate** (same email, or same phone
  in any format), and an admin merges with one click. A merge moves conversations,
  identities, leads, tickets, appointments, notes and tags, fills empty fields, combines
  memory, closes duplicate open conversations and leaves an empty tombstone
  (`mergedIntoId`); open widget sessions follow it and get a new token.
* **GDPR:** export everything about a customer as JSON; erase a customer (profile,
  conversations, messages, files in S3, leads, tickets, appointments, notes, merged
  tombstones; usage records keep only ids); delete a single conversation with its files.
  Every export and erasure is audited.
* **Leads** (`modules/leads/`): pipeline board (drag between stages) and list, manual
  creation linked to the customer with the same email/phone (or a new profile),
  owner assignment with notification, `closedAt` / `lostReason`, activity from the audit
  log, stats (open, pipeline value, win rate and conversion over 90 days), and CSV export
  protected against spreadsheet formula injection. Stage changes emit
  `lead.status_changed` for webhooks and integrations.

## 8e. Analytics and AI insights (phase 8)

`server/modules/analytics/`: `period.ts` (presets, custom ranges ≤ 1 year in the
organization's time zone, previous period of equal length), `report-service.ts`
(KPIs, series, channels, intents, sentiment, knowledge usage, AI cost by kind/model,
team), `questions.ts` and `insights-service.ts`.

* **Answered or not** is decided from what each AI reply recorded (phase 3/4): cited
  sources, knowledge-retrieval hits, data tools that succeeded (products, orders, hours,
  profile) and provider fallbacks. Replies by team members are not judged. No extra AI
  calls are needed.
* **Topics** (`lib/topics.ts`) are local, deterministic keyword clusters: stop-words and
  chat filler in all supported languages are removed, words are lightly stemmed
  ("installation" = "install"), emails/links are ignored, and each topic is labelled with
  the words customers actually used. Knowledge gaps are topics of unanswered questions;
  each links to the knowledge base with those questions pre-filled as FAQ entries.
* **AI report** (on demand, rate-limited, stored in `InsightReport`): only aggregates and
  short examples with emails/phone numbers redacted are sent to the model; the JSON answer
  is validated before it is saved. Its cost is recorded like any other AI call.
* **Escalations** are counted from `metadata.handoff.requestedAt`, which survives "return
  to AI" (that clears `handoffRequestedAt`). Human response time = handoff → first team
  reply.

## 9. Security model

* Auth.js credentials provider, bcrypt (cost 12), JWT session carrying only `userId`
  and `activeOrganizationId`; **role is re-read from the database on every request**,
  so role changes and removals take effect immediately.
* `middleware.ts` blocks unauthenticated dashboard access; every route handler and page
  re-checks via `requireApiAuth(permission)` / `requirePageAuth(permission)` — the UI
  hiding a button is never the only check. Pages with a `loading.tsx` check permissions
  in their segment layout so unauthorized users get a real redirect before streaming.
* Permission matrix in `lib/permissions.ts` (shared so UI and server agree).
* Zod validation on all input; Prisma parameterization (raw SQL only via tagged
  templates); React escaping, no `dangerouslySetInnerHTML` for user content.
* Rate limiting (Redis, in-memory fallback) on login, registration, public widget APIs.
* Webhook HMAC verification (Meta `X-Hub-Signature-256`); outbound webhooks signed.
* Same-origin check on state-changing API requests (CSRF), Auth.js CSRF for auth.
* Security headers: `frame-ancestors 'none'` / `X-Frame-Options: DENY` outside `/widget/*`, nosniff,
  referrer policy, permissions policy, HSTS in production. A full script-src CSP (nonce-based)
  is planned for phase 10.
* Audit log for security-relevant actions. Structured logs with redaction.
* Secrets only in server env; nothing sensitive is prefixed `NEXT_PUBLIC_`.

## 10. Implementation phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, DB schema, auth, RBAC, tenancy, admin shell, Docker, seed | ✅ |
| 2 | Embeddable website widget + public widget API + SSE | ✅ |
| 3 | AI messaging pipeline, prompt layers, tools, memory, guardrails | ✅ |
| 4 | Knowledge base / RAG | ✅ |
| 5 | WhatsApp Cloud API | ✅ |
| 6 | Unified inbox + human handoff + suggested replies | ✅ |
| 7 | Customers + leads | ✅ |
| 8 | Analytics + AI insights | ✅ |
| 9 | Automations + outbound webhooks + integration interfaces | ✅ |
| 10 | Hardening, GDPR tooling, tests, deployment | ⏳ |
