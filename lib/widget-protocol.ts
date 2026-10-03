// Shared contract between the widget (iframe), the loader script and the widget API.
// Client-safe: no server imports.

export type WidgetPosition = 'bottom-right' | 'bottom-left';
export type WidgetRole = 'customer' | 'ai' | 'agent' | 'system';
export type WidgetMessageStatus = 'sending' | 'sent' | 'read' | 'failed';
export type WidgetConversationStatus = 'AI_ACTIVE' | 'WAITING_FOR_AGENT' | 'HUMAN_ACTIVE' | 'CLOSED';

export interface WidgetConfig {
  botKey: string;
  agentName: string;
  companyName: string;
  welcomeMessage: string;
  primaryColor: string;
  position: WidgetPosition;
  avatarUrl: string | null;
  logoUrl: string | null;
  quickReplies: string[];
  allowAttachments: boolean;
  showSources: boolean;
  defaultLanguage: string;
  team: {
    /** Inside configured business hours. */
    online: boolean;
    /** ISO timestamp of the next opening when offline (null if unknown/always closed). */
    nextOpenAt: string | null;
  };
}

export interface WidgetAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  /** Signed, short-lived download URL. */
  url: string;
}

/** Attachment reference returned by the upload endpoint and sent back with a message. */
export interface UploadReceipt {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  /** Server signature binding the receipt to this visitor. */
  sig: string;
  /** Preview URL for the uploader. */
  url: string;
}

export interface WidgetAction {
  label: string;
  action: 'handoff' | 'restart';
}

export interface WidgetLinkButton {
  label: string;
  url: string;
}

export interface WidgetMessage {
  id: string;
  role: WidgetRole;
  content: string;
  createdAt: string;
  status: WidgetMessageStatus;
  clientMessageId?: string;
  attachments: WidgetAttachment[];
  sources: { title: string }[];
  quickReplies: string[];
  actions: WidgetAction[];
  buttons: WidgetLinkButton[];
  /** Display name for agent messages. */
  authorName?: string | null;
}

export interface WidgetConversation {
  id: string;
  status: WidgetConversationStatus;
  agentName: string | null;
  handoffRequested: boolean;
}

export interface WidgetSession {
  token: string;
  customer: { id: string; name: string | null };
  conversation: WidgetConversation | null;
  messages: WidgetMessage[];
}

/** Events sent over SSE (both the per-message reply stream and the long-lived events stream). */
export type WidgetEvent =
  | { type: 'message'; message: WidgetMessage; conversation?: WidgetConversation }
  | { type: 'assistant.start'; streamId: string }
  | { type: 'assistant.delta'; streamId: string; text: string }
  /** The assistant is using a tool (looking something up / doing something). */
  | { type: 'assistant.status'; streamId: string; status: 'searching' | 'working' }
  | { type: 'assistant.done'; streamId: string; message: WidgetMessage }
  | { type: 'conversation'; conversation: WidgetConversation }
  | { type: 'typing'; name: string | null }
  | { type: 'error'; code: string; message: string };

// ── iframe ⇄ loader postMessage protocol ──────────────────────────────

export const WIDGET_SOURCE = 'omniai-widget';
export const LOADER_SOURCE = 'omniai-loader';

export type WidgetFrameState = 'hidden' | 'closed' | 'teaser' | 'open' | 'expanded' | 'fullscreen';

export type WidgetToLoaderMessage =
  | { source: typeof WIDGET_SOURCE; type: 'ready' }
  | { source: typeof WIDGET_SOURCE; type: 'resize'; state: WidgetFrameState; position: WidgetPosition; width: number; height: number }
  | { source: typeof WIDGET_SOURCE; type: 'store'; token: string | null };

export type LoaderToWidgetMessage =
  | {
      source: typeof LOADER_SOURCE;
      type: 'init';
      token: string | null;
      pageUrl: string;
      pageTitle: string;
      locale: string;
      viewport: { width: number; height: number };
    }
  | { source: typeof LOADER_SOURCE; type: 'viewport'; viewport: { width: number; height: number } }
  | { source: typeof LOADER_SOURCE; type: 'open' | 'close' | 'toggle' };

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_ATTACHMENTS = 4;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
