'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type {
  UploadReceipt,
  WidgetConfig,
  WidgetConversation,
  WidgetEvent,
  WidgetMessage,
} from '@/lib/widget-protocol';
import { WidgetApiError, WidgetTransport } from './transport';

export interface PendingUpload {
  id: string;
  fileName: string;
  status: 'uploading' | 'done' | 'error';
  receipt?: UploadReceipt;
  error?: string;
}

export interface WidgetState {
  phase: 'idle' | 'loading' | 'ready' | 'blocked' | 'error';
  error: string | null;
  config: WidgetConfig;
  conversation: WidgetConversation | null;
  messages: WidgetMessage[];
  /** AI reply currently streaming in. */
  streaming: { streamId: string; text: string; status: 'searching' | 'working' | null } | null;
  /** Waiting for the first token of a reply. */
  awaitingReply: boolean;
  connection: 'connected' | 'reconnecting';
  unread: number;
}

type Action =
  | { type: 'loading' }
  | { type: 'ready'; config: WidgetConfig; conversation: WidgetConversation | null; messages: WidgetMessage[] }
  | { type: 'failed'; phase: 'blocked' | 'error'; error: string }
  | { type: 'upsert'; message: WidgetMessage; countUnread: boolean }
  | { type: 'conversation'; conversation: WidgetConversation | null }
  | { type: 'streamStart'; streamId: string }
  | { type: 'streamDelta'; streamId: string; text: string }
  | { type: 'streamStatus'; streamId: string; status: 'searching' | 'working' }
  | { type: 'streamEnd' }
  | { type: 'awaiting'; value: boolean }
  | { type: 'markFailed'; clientMessageId: string }
  | { type: 'markCustomerRead' }
  | { type: 'connection'; value: 'connected' | 'reconnecting' }
  | { type: 'reset' }
  | { type: 'clearUnread' };

/** Inserts or replaces a message (by id, or by clientMessageId for optimistic ones), keeping order. */
function upsertMessage(list: WidgetMessage[], message: WidgetMessage): { list: WidgetMessage[]; isNew: boolean } {
  const index = list.findIndex(
    (m) => m.id === message.id || (message.clientMessageId && m.clientMessageId === message.clientMessageId),
  );
  if (index >= 0) {
    const next = list.slice();
    next[index] = message;
    return { list: next, isNew: false };
  }
  const next = [...list, message].sort((a, b) =>
    a.status === 'sending' || a.status === 'failed' ? 1 : b.status === 'sending' || b.status === 'failed' ? -1 : a.createdAt.localeCompare(b.createdAt),
  );
  return { list: next, isNew: true };
}

function reducer(state: WidgetState, action: Action): WidgetState {
  switch (action.type) {
    case 'loading':
      return { ...state, phase: 'loading', error: null };
    case 'ready':
      return { ...state, phase: 'ready', config: action.config, conversation: action.conversation, messages: action.messages };
    case 'failed':
      return { ...state, phase: action.phase, error: action.error };
    case 'upsert': {
      const { list, isNew } = upsertMessage(state.messages, action.message);
      const fromTeam = action.message.role === 'ai' || action.message.role === 'agent';
      return { ...state, messages: list, unread: state.unread + (isNew && fromTeam && action.countUnread ? 1 : 0) };
    }
    case 'conversation':
      return { ...state, conversation: action.conversation };
    case 'streamStart':
      return { ...state, awaitingReply: true, streaming: { streamId: action.streamId, text: '', status: null } };
    case 'streamStatus':
      return state.streaming?.streamId === action.streamId ? { ...state, streaming: { ...state.streaming, status: action.status } } : state;
    case 'streamDelta':
      return {
        ...state,
        awaitingReply: false,
        streaming: {
          streamId: action.streamId,
          text: (state.streaming?.streamId === action.streamId ? state.streaming.text : '') + action.text,
          status: null,
        },
      };
    case 'streamEnd':
      return { ...state, streaming: null, awaitingReply: false };
    case 'awaiting':
      return { ...state, awaitingReply: action.value };
    case 'markFailed':
      return {
        ...state,
        awaitingReply: false,
        streaming: null,
        messages: state.messages.map((m) => (m.clientMessageId === action.clientMessageId && m.status === 'sending' ? { ...m, status: 'failed' } : m)),
      };
    case 'markCustomerRead':
      return { ...state, messages: state.messages.map((m) => (m.role === 'customer' && m.status === 'sent' ? { ...m, status: 'read' } : m)) };
    case 'connection':
      return { ...state, connection: action.value };
    case 'reset':
      return { ...state, conversation: null, messages: [], streaming: null, awaitingReply: false };
    case 'clearUnread':
      return { ...state, unread: 0 };
  }
}

const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export interface SessionInit {
  token: string | null;
  hostOrigin: string | null;
  pageUrl: string | null;
  locale: string;
}

export function useWidgetSession(options: {
  initialConfig: WidgetConfig;
  isOpen: boolean;
  onToken: (token: string | null) => void;
}) {
  const { initialConfig, onToken } = options;
  const transport = useRef(new WidgetTransport(initialConfig.botKey)).current;
  const [state, dispatch] = useReducer(reducer, {
    phase: 'idle',
    error: null,
    config: initialConfig,
    conversation: null,
    messages: [],
    streaming: null,
    awaitingReply: false,
    connection: 'connected',
    unread: 0,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const openRef = useRef(options.isOpen);
  openRef.current = options.isOpen;
  const initRef = useRef<SessionInit | null>(null);
  const eventsAbort = useRef<AbortController | null>(null);

  const handleEvent = useCallback((event: WidgetEvent, fromOwnSend: boolean) => {
    switch (event.type) {
      case 'message':
        dispatch({ type: 'upsert', message: event.message, countUnread: !openRef.current && !fromOwnSend });
        if (event.conversation) dispatch({ type: 'conversation', conversation: event.conversation });
        break;
      case 'conversation':
        dispatch({ type: 'conversation', conversation: event.conversation });
        break;
      case 'assistant.start':
        dispatch({ type: 'streamStart', streamId: event.streamId });
        break;
      case 'assistant.delta':
        dispatch({ type: 'streamDelta', streamId: event.streamId, text: event.text });
        break;
      case 'assistant.status':
        dispatch({ type: 'streamStatus', streamId: event.streamId, status: event.status });
        break;
      case 'assistant.done':
        dispatch({ type: 'upsert', message: event.message, countUnread: !openRef.current });
        dispatch({ type: 'streamEnd' });
        dispatch({ type: 'markCustomerRead' });
        break;
      default:
        break;
    }
  }, []);

  /** Keeps the events stream open with backoff; catches up on missed messages after reconnects. */
  const runEvents = useCallback(async () => {
    eventsAbort.current?.abort();
    const controller = new AbortController();
    eventsAbort.current = controller;
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        if (attempt > 0) {
          const lastId = stateRef.current.messages.filter((m) => m.status !== 'sending' && m.status !== 'failed').at(-1)?.id ?? null;
          const since = await transport.messagesSince(lastId);
          since.messages.forEach((m) => dispatch({ type: 'upsert', message: m, countUnread: !openRef.current }));
          dispatch({ type: 'conversation', conversation: since.conversation });
        }
        dispatch({ type: 'connection', value: 'connected' });
        attempt = 0;
        await transport.events((e) => handleEvent(e, false), controller.signal);
        attempt = 1; // normal server-side rotation: reconnect immediately, then catch up
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof WidgetApiError && err.status === 401) {
          // Session invalid (e.g. data deleted): start over as a new visitor.
          onToken(null);
          return;
        }
        attempt++;
        dispatch({ type: 'connection', value: 'reconnecting' });
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** Math.min(attempt, 4), 15_000)));
      }
    }
  }, [handleEvent, onToken, transport]);

  const start = useCallback(
    async (init: SessionInit) => {
      initRef.current = init;
      dispatch({ type: 'loading' });
      try {
        const session = await transport.startSession(init);
        if (session.token !== init.token) onToken(session.token);
        dispatch({ type: 'ready', config: session.config, conversation: session.conversation, messages: session.messages });
        void runEvents();
      } catch (err) {
        const blocked = err instanceof WidgetApiError && (err.status === 403 || err.status === 404);
        dispatch({ type: 'failed', phase: blocked ? 'blocked' : 'error', error: (err as Error).message });
      }
    },
    [onToken, runEvents, transport],
  );

  useEffect(() => () => eventsAbort.current?.abort(), []);

  const deliver = useCallback(
    async (clientMessageId: string, content: string, attachments: UploadReceipt[]) => {
      try {
        await transport.sendMessage(
          { clientMessageId, content, attachments, pageUrl: initRef.current?.pageUrl ?? undefined },
          (e) => {
            if (e.type === 'error') dispatch({ type: 'markFailed', clientMessageId });
            else handleEvent(e, true);
          },
        );
        // Stream ended without a reply (human mode, or connection cut): stop the indicator.
        dispatch({ type: 'streamEnd' });
      } catch {
        dispatch({ type: 'markFailed', clientMessageId });
      }
    },
    [handleEvent, transport],
  );

  const send = useCallback(
    (content: string, attachments: UploadReceipt[] = []) => {
      const text = content.trim();
      if (!text && attachments.length === 0) return;
      const clientMessageId = newClientId();
      dispatch({
        type: 'upsert',
        countUnread: false,
        message: {
          id: `local:${clientMessageId}`,
          clientMessageId,
          role: 'customer',
          content: text,
          createdAt: new Date().toISOString(),
          status: 'sending',
          attachments: attachments.map((a) => ({ fileName: a.fileName, mimeType: a.mimeType, size: a.size, url: a.url })),
          sources: [],
          quickReplies: [],
          actions: [],
          buttons: [],
        },
      });
      if (stateRef.current.conversation?.status !== 'WAITING_FOR_AGENT' && stateRef.current.conversation?.status !== 'HUMAN_ACTIVE') {
        dispatch({ type: 'awaiting', value: true });
      }
      void deliver(clientMessageId, text, attachments).then(() => undefined);
      return clientMessageId;
    },
    [deliver],
  );

  const pendingAttachments = useRef(new Map<string, UploadReceipt[]>());

  /** Re-sends a failed message with the same client id (the server de-duplicates). */
  const retry = useCallback(
    (message: WidgetMessage) => {
      if (!message.clientMessageId) return;
      dispatch({ type: 'upsert', countUnread: false, message: { ...message, status: 'sending' } });
      dispatch({ type: 'awaiting', value: true });
      void deliver(message.clientMessageId, message.content, pendingAttachments.current.get(message.clientMessageId) ?? []);
    },
    [deliver],
  );

  const sendWithAttachments = useCallback(
    (content: string, attachments: UploadReceipt[]) => {
      const id = send(content, attachments);
      if (id && attachments.length) pendingAttachments.current.set(id, attachments);
    },
    [send],
  );

  const restart = useCallback(async () => {
    await transport.restart();
    dispatch({ type: 'reset' });
  }, [transport]);

  const handoff = useCallback(async () => {
    const result = await transport.handoff();
    dispatch({ type: 'conversation', conversation: result.conversation });
    if (result.message) dispatch({ type: 'upsert', message: result.message, countUnread: false });
  }, [transport]);

  const upload = useCallback((file: File) => transport.upload(file), [transport]);
  const clearUnread = useCallback(() => dispatch({ type: 'clearUnread' }), []);

  return { state, start, send: sendWithAttachments, retry, restart, handoff, upload, clearUnread };
}
