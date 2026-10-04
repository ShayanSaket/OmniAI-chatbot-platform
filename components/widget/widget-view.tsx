'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  FileText,
  Headset,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  SendHorizontal,
  WifiOff,
  X,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { readableTextColor, withAlpha } from '@/lib/color';
import { cn } from '@/lib/utils';
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_LENGTH,
  type UploadReceipt,
  type WidgetConfig,
  type WidgetConversation,
  type WidgetMessage,
} from '@/lib/widget-protocol';
import { isHandoffPhrase, type WidgetLang, type WidgetStrings } from './i18n';
import { Markdown } from './markdown';

// ── Theme ─────────────────────────────────────────────────────────────

export function widgetThemeStyle(primary: string): React.CSSProperties {
  return {
    ['--w-primary' as string]: primary,
    ['--w-on-primary' as string]: readableTextColor(primary),
    ['--w-primary-soft' as string]: withAlpha(primary, 0.1),
    ['--w-primary-ring' as string]: withAlpha(primary, 0.35),
  };
}

// ── Small pieces ───────────────────────────────────────────────────────

export function BotAvatar({ config, size = 32 }: { config: Pick<WidgetConfig, 'avatarUrl' | 'agentName'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const style = { width: size, height: size };
  if (config.avatarUrl && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={config.avatarUrl} alt="" style={style} className="shrink-0 rounded-full object-cover" onError={() => setFailed(true)} />
    );
  }
  return (
    <span style={style} className="flex shrink-0 items-center justify-center rounded-full bg-[var(--w-primary)] text-[var(--w-on-primary)]">
      <Bot style={{ width: size * 0.55, height: size * 0.55 }} aria-hidden />
    </span>
  );
}

function AgentAvatar({ name, size = 28 }: { name: string | null | undefined; size?: number }) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  return (
    <span style={{ width: size, height: size }} className="flex shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-semibold text-white">
      {initials || <Headset className="h-3.5 w-3.5" />}
    </span>
  );
}

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot h-1.5 w-1.5 rounded-full bg-slate-400" style={{ animationDelay: `${i * 0.18}s` }} />
      ))}
    </span>
  );
}

// ── Launcher & teaser ─────────────────────────────────────────────────

export function Launcher({ open, unread, onClick, strings }: { open: boolean; unread: number; onClick: () => void; strings: WidgetStrings }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={open ? strings.closeChat : strings.openChat}
      aria-expanded={open}
      className="relative flex h-14 w-14 items-center justify-center rounded-full bg-[var(--w-primary)] text-[var(--w-on-primary)] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.35)] outline-none transition-transform duration-200 hover:scale-105 focus-visible:ring-4 focus-visible:ring-[var(--w-primary-ring)] active:scale-95"
    >
      <MessageCircle className={cn('absolute h-6 w-6 transition-all duration-200', open ? 'rotate-90 scale-0 opacity-0' : 'rotate-0 scale-100 opacity-100')} />
      <ChevronDown className={cn('absolute h-6 w-6 transition-all duration-200', open ? 'rotate-0 scale-100 opacity-100' : '-rotate-90 scale-0 opacity-0')} />
      {!open && unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-semibold text-white ring-2 ring-white">
          {unread > 9 ? '9+' : unread}
          <span className="sr-only"> unread</span>
        </span>
      )}
    </button>
  );
}

export function Teaser({ config, onOpen, onDismiss, strings, dir }: { config: WidgetConfig; onOpen: () => void; onDismiss: () => void; strings: WidgetStrings; dir?: 'ltr' | 'rtl' }) {
  return (
    <div dir={dir} className="animate-slide-up relative w-[280px] rounded-2xl rounded-ee-md bg-white p-3.5 pe-8 text-[13.5px] leading-relaxed text-slate-700 shadow-[0_12px_32px_-8px_rgba(15,23,42,0.3)] ring-1 ring-slate-900/5">
      <button type="button" onClick={onOpen} className="flex w-full items-start gap-2.5 text-start">
        <BotAvatar config={config} size={28} />
        <span className="line-clamp-3">{config.welcomeMessage}</span>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={strings.dismiss}
        className="absolute end-2 top-2 rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────

function statusLine(config: WidgetConfig, conversation: WidgetConversation | null, strings: WidgetStrings, lang: WidgetLang) {
  if (conversation?.status === 'HUMAN_ACTIVE') {
    // The agent's name is already the header title.
    return { dot: 'bg-emerald-500', text: strings.teamMember };
  }
  if (conversation?.status === 'WAITING_FOR_AGENT') return { dot: 'bg-amber-500 animate-pulse-dot', text: strings.waitingForAgent };
  if (config.team.online) return { dot: 'bg-emerald-500', text: `${strings.aiAssistant} · ${strings.teamOnline}` };
  const when = config.team.nextOpenAt
    ? new Intl.DateTimeFormat(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(config.team.nextOpenAt))
    : null;
  return { dot: 'bg-slate-300', text: `${strings.aiAssistant} · ${when ? strings.teamBack(when) : strings.teamOffline}` };
}

interface HeaderProps {
  config: WidgetConfig;
  conversation: WidgetConversation | null;
  strings: WidgetStrings;
  lang: WidgetLang;
  expanded: boolean;
  canExpand: boolean;
  onClose?: () => void;
  onToggleExpand?: () => void;
  onRestart?: () => void;
  onHandoff?: () => void;
}

function Header({ config, conversation, strings, lang, expanded, canExpand, onClose, onToggleExpand, onRestart, onHandoff }: HeaderProps) {
  const status = statusLine(config, conversation, strings, lang);
  const human = conversation?.status === 'HUMAN_ACTIVE';
  const canHandoff = !conversation || conversation.status === 'AI_ACTIVE';
  return (
    <header className="relative flex items-center gap-3 bg-[var(--w-primary)] px-4 pb-4 pt-4 text-[var(--w-on-primary)]">
      <div className="relative">
        {human ? <AgentAvatar name={conversation?.agentName} size={40} /> : <BotAvatar config={config} size={40} />}
        <span className={cn('absolute -bottom-0.5 -end-0.5 h-3 w-3 rounded-full ring-2 ring-[var(--w-primary)]', status.dot)} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold leading-tight">{human ? conversation?.agentName ?? strings.teamMember : config.agentName}</p>
        <p className="mt-0.5 truncate text-[12px] opacity-80">{status.text}</p>
      </div>
      <div className="flex items-center gap-0.5">
        {(onRestart || onHandoff || (canExpand && onToggleExpand)) && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              aria-label={strings.menu}
              className="rounded-full p-2 opacity-85 outline-none transition hover:bg-white/15 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <MoreHorizontal className="h-5 w-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 text-[13px]">
              {onHandoff && canHandoff && (
                <DropdownMenuItem onSelect={onHandoff}>
                  <Headset className="me-2 h-4 w-4" /> {strings.talkToHuman}
                </DropdownMenuItem>
              )}
              {onRestart && (
                <DropdownMenuItem onSelect={onRestart}>
                  <RotateCcw className="me-2 h-4 w-4" /> {strings.restart}
                </DropdownMenuItem>
              )}
              {canExpand && onToggleExpand && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={onToggleExpand}>
                    {expanded ? <Minimize2 className="me-2 h-4 w-4" /> : <Maximize2 className="me-2 h-4 w-4" />}
                    {expanded ? strings.collapse : strings.expand}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={strings.closeChat}
            className="rounded-full p-2 opacity-85 outline-none transition hover:bg-white/15 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  );
}

// ── Messages ─────────────────────────────────────────────────────────

function dayLabel(iso: string, strings: WidgetStrings, lang: WidgetLang) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return strings.today;
  if (d.toDateString() === yesterday.toDateString()) return strings.yesterday;
  return new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}

const timeOf = (iso: string, lang: WidgetLang) => new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function StatusIcon({ status, strings }: { status: WidgetMessage['status']; strings: WidgetStrings }) {
  if (status === 'sending') return <Clock className="h-3 w-3" aria-label={strings.sending} />;
  if (status === 'read') return <CheckCheck className="h-3.5 w-3.5 text-[var(--w-primary)]" aria-label={strings.read} />;
  if (status === 'sent') return <Check className="h-3.5 w-3.5" aria-label={strings.sent} />;
  return null;
}

function Attachments({ message, mine }: { message: WidgetMessage; mine: boolean }) {
  if (!message.attachments.length) return null;
  return (
    <div className={cn('mb-1 flex flex-wrap gap-1.5', mine ? 'justify-end' : 'justify-start')}>
      {message.attachments.map((a) =>
        a.mimeType.startsWith('image/') ? (
          <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl ring-1 ring-slate-900/10">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={a.url} alt={a.fileName} className="max-h-48 max-w-[220px] object-cover" loading="lazy" />
          </a>
        ) : (
          <a
            key={a.url}
            href={a.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex max-w-[240px] items-center gap-2.5 rounded-xl bg-white px-3 py-2 text-start ring-1 ring-slate-900/10 transition hover:bg-slate-50"
          >
            <FileText className="h-5 w-5 shrink-0 text-slate-500" />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-slate-800">{a.fileName}</span>
              <span className="block text-[11px] text-slate-500">{formatSize(a.size)}</span>
            </span>
          </a>
        ),
      )}
    </div>
  );
}

interface Group {
  role: WidgetMessage['role'];
  authorName?: string | null;
  messages: WidgetMessage[];
}

function groupMessages(messages: WidgetMessage[]): { day: string; groups: Group[] }[] {
  const days: { day: string; groups: Group[] }[] = [];
  for (const m of messages) {
    const dayKey = new Date(m.createdAt).toDateString();
    let day = days.at(-1);
    if (!day || day.day !== dayKey) {
      day = { day: dayKey, groups: [] };
      days.push(day);
    }
    const last = day.groups.at(-1);
    const lastMsg = last?.messages.at(-1);
    const close = lastMsg && new Date(m.createdAt).getTime() - new Date(lastMsg.createdAt).getTime() < 3 * 60_000;
    if (last && last.role === m.role && m.role !== 'system' && last.authorName === m.authorName && close) last.messages.push(m);
    else day.groups.push({ role: m.role, authorName: m.authorName, messages: [m] });
  }
  return days;
}

export interface MessageListProps {
  config: WidgetConfig;
  messages: WidgetMessage[];
  streamingText: string | null;
  /** Tool activity while the reply is being prepared. */
  streamingStatus?: 'searching' | 'working' | null;
  awaitingReply: boolean;
  /** A team member is typing (name or ''), null otherwise. */
  agentTyping?: string | null;
  strings: WidgetStrings;
  lang: WidgetLang;
  onQuickReply?: (text: string) => void;
  onAction?: (action: 'handoff' | 'restart') => void;
  onRetry?: (message: WidgetMessage) => void;
}

export function MessageList({
  config,
  messages,
  streamingText,
  streamingStatus,
  awaitingReply,
  agentTyping = null,
  strings,
  lang,
  onQuickReply,
  onAction,
  onRetry,
}: MessageListProps) {
  const statusLabel = streamingStatus === 'searching' ? strings.searching : streamingStatus === 'working' ? strings.working : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const days = useMemo(() => groupMessages(messages), [messages]);
  const last = messages.at(-1);
  const suggestions =
    !streamingText && !awaitingReply
      ? !last
        ? { quickReplies: config.quickReplies, actions: [] as WidgetMessage['actions'] }
        : last.role === 'ai' || last.role === 'system'
          ? { quickReplies: last.quickReplies, actions: last.actions }
          : null
      : null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, awaitingReply, streamingStatus, agentTyping]);

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="scrollbar-thin flex-1 overflow-y-auto overscroll-contain px-4 pb-3 pt-4"
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {/* Welcome message (configured greeting, always first) */}
      <div className="mb-3 flex items-end gap-2">
        <BotAvatar config={config} size={28} />
        <div className="max-w-[82%] rounded-2xl rounded-es-md bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-slate-800 shadow-sm ring-1 ring-slate-900/[0.06]">
          <Markdown source={config.welcomeMessage} />
        </div>
      </div>

      {days.map((day) => (
        <div key={day.day}>
          <div className="my-3 flex items-center gap-3 text-[11px] font-medium text-slate-400">
            <span className="h-px flex-1 bg-slate-200" />
            {dayLabel(day.groups[0]!.messages[0]!.createdAt, strings, lang)}
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          {day.groups.map((g) => {
            const first = g.messages[0]!;
            if (g.role === 'system') {
              return g.messages.map((m) => (
                <div key={m.id} className="my-3 flex justify-center">
                  <p dir="auto" className="max-w-[90%] rounded-xl bg-slate-100 px-3 py-2 text-center text-[12.5px] leading-relaxed text-slate-600">{m.content}</p>
                </div>
              ));
            }
            const mine = g.role === 'customer';
            const lastMsg = g.messages.at(-1)!;
            return (
              <div key={first.id} className={cn('mb-3 flex items-end gap-2', mine && 'flex-row-reverse')}>
                {!mine && (g.role === 'agent' ? <AgentAvatar name={g.authorName} /> : <BotAvatar config={config} size={28} />)}
                <div className={cn('flex max-w-[82%] flex-col gap-1', mine ? 'items-end' : 'items-start')}>
                  {g.role === 'agent' && g.authorName && <span className="px-1 text-[11px] font-medium text-slate-500">{g.authorName}</span>}
                  {g.messages.map((m) => (
                    <div key={m.id} className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
                      <Attachments message={m} mine={mine} />
                      {m.content && (
                        <div
                          className={cn(
                            'rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed',
                            mine
                              ? 'rounded-ee-md bg-[var(--w-primary)] text-[var(--w-on-primary)]'
                              : 'rounded-es-md bg-white text-slate-800 shadow-sm ring-1 ring-slate-900/[0.06]',
                            m.status === 'failed' && 'opacity-60',
                          )}
                        >
                          {mine ? <p dir="auto" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{m.content}</p> : <Markdown source={m.content} />}
                        </div>
                      )}
                      {config.showSources && m.sources.length > 0 && (
                        <p className="mt-1 px-1 text-[11px] text-slate-500">
                          {strings.sources}: {m.sources.map((s) => s.title).join(' · ')}
                        </p>
                      )}
                      {m.buttons.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {m.buttons.map((b) => (
                            <a
                              key={b.url}
                              href={b.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="rounded-full bg-white px-3 py-1.5 text-[13px] font-medium text-[var(--w-primary)] ring-1 ring-[var(--w-primary-ring)] transition hover:bg-[var(--w-primary-soft)]"
                            >
                              {b.label}
                            </a>
                          ))}
                        </div>
                      )}
                      {m.status === 'failed' && (
                        <button type="button" onClick={() => onRetry?.(m)} className="mt-1 flex items-center gap-1 text-[11px] font-medium text-rose-600 hover:underline">
                          <AlertCircle className="h-3 w-3" /> {strings.failed} · {strings.retry}
                        </button>
                      )}
                    </div>
                  ))}
                  <span className="flex items-center gap-1 px-1 text-[10.5px] text-slate-400">
                    {timeOf(lastMsg.createdAt, lang)}
                    {mine && <StatusIcon status={lastMsg.status} strings={strings} />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      {agentTyping !== null && !awaitingReply && !streamingText && (
        <div className="mb-3 flex items-end gap-2" role="status">
          <AgentAvatar name={agentTyping || null} size={28} />
          <div className="rounded-2xl rounded-es-md bg-white px-3.5 py-2.5 shadow-sm ring-1 ring-slate-900/[0.06]">
            <TypingDots />
            <span className="sr-only">
              {agentTyping || strings.teamMember} {strings.typing}
            </span>
          </div>
        </div>
      )}

      {(awaitingReply || streamingText) && (
        <div className="mb-3 flex items-end gap-2">
          <BotAvatar config={config} size={28} />
          <div className="max-w-[82%] rounded-2xl rounded-es-md bg-white px-3.5 py-2.5 text-[14px] leading-relaxed text-slate-800 shadow-sm ring-1 ring-slate-900/[0.06]">
            {streamingText ? (
              <div className="relative">
                <Markdown source={streamingText} />
                {statusLabel ? (
                  <div className="mt-1.5 flex items-center gap-2 text-[12px] text-slate-500" role="status">
                    <TypingDots />
                    {statusLabel}
                  </div>
                ) : (
                  <span className="ms-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-sm bg-[var(--w-primary)]" aria-hidden />
                )}
              </div>
            ) : statusLabel ? (
              <div className="flex items-center gap-2 text-[12px] text-slate-500" role="status">
                <TypingDots />
                {statusLabel}
              </div>
            ) : (
              <>
                <TypingDots />
                <span className="sr-only">
                  {config.agentName} {strings.typing}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {suggestions && (suggestions.quickReplies.length > 0 || suggestions.actions.length > 0) && (
        <div className="mt-1 flex flex-wrap justify-end gap-1.5 ps-9">
          {suggestions.actions.map((a) => (
            <button
              key={a.action}
              type="button"
              onClick={() => onAction?.(a.action)}
              className="flex items-center gap-1.5 rounded-full bg-[var(--w-primary)] px-3 py-1.5 text-[13px] font-medium text-[var(--w-on-primary)] shadow-sm transition hover:opacity-90"
            >
              {a.action === 'handoff' && <Headset className="h-3.5 w-3.5" />}
              {a.label}
            </button>
          ))}
          {suggestions.quickReplies.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onQuickReply?.(q)}
              className="rounded-full bg-white px-3 py-1.5 text-[13px] font-medium text-[var(--w-primary)] ring-1 ring-[var(--w-primary-ring)] transition hover:bg-[var(--w-primary-soft)]"
            >
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────

interface ComposerProps {
  strings: WidgetStrings;
  allowAttachments: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments: UploadReceipt[]) => void;
  upload?: (file: File) => Promise<UploadReceipt>;
  autoFocus?: boolean;
}

interface ComposerUpload {
  id: string;
  fileName: string;
  receipt?: UploadReceipt;
  error?: string;
}

function Composer({ strings, allowAttachments, disabled, onSend, upload, autoFocus }: ComposerProps) {
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<ComposerUpload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploads.some((u) => !u.receipt && !u.error);
  const ready = uploads.filter((u) => u.receipt).map((u) => u.receipt!);
  const canSend = !disabled && !uploading && (text.trim().length > 0 || ready.length > 0) && text.length <= MAX_MESSAGE_LENGTH;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '';
    if (!text) return;
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = () => {
    if (!canSend) return;
    onSend(text, ready);
    setText('');
    setUploads([]);
    textareaRef.current?.focus();
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || !upload) return;
    const room = MAX_ATTACHMENTS - uploads.length;
    for (const file of Array.from(files).slice(0, room)) {
      const id = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
      setUploads((u) => [...u, { id, fileName: file.name }]);
      try {
        const receipt = await upload(file);
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, receipt } : x)));
      } catch (err) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: (err as Error).message } : x)));
      }
    }
  };

  return (
    <div className="border-t border-slate-200/80 bg-white px-3 pb-2 pt-2.5">
      {uploads.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {uploads.map((u) => (
            <li
              key={u.id}
              title={u.error}
              className={cn(
                'flex max-w-[200px] items-center gap-1.5 rounded-lg px-2 py-1 text-[12px]',
                u.error ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-700',
              )}
            >
              {!u.receipt && !u.error ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : u.error ? <AlertCircle className="h-3.5 w-3.5 shrink-0" /> : <Paperclip className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{u.error ? u.error : u.fileName}</span>
              <button
                type="button"
                aria-label={strings.removeAttachment}
                onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}
                className="rounded p-0.5 hover:bg-black/5"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-1.5">
        {allowAttachments && upload && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.docx,.txt,.md,.csv"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploads.length >= MAX_ATTACHMENTS}
              aria-label={strings.attach}
              className="mb-0.5 rounded-full p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          </>
        )}
        <label className="sr-only" htmlFor="omniai-composer">
          {strings.placeholder}
        </label>
        <textarea
          id="omniai-composer"
          ref={textareaRef}
          rows={1}
          value={text}
          disabled={disabled}
          maxLength={MAX_MESSAGE_LENGTH + 100}
          placeholder={strings.placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length && allowAttachments) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
          dir="auto"
          className="h-10 max-h-[120px] min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-2 text-[14.5px] leading-snug text-slate-800 outline-none placeholder:text-slate-400"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label={strings.send}
          className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--w-primary)] text-[var(--w-on-primary)] transition hover:opacity-90 disabled:bg-slate-200 disabled:text-slate-400"
        >
          <SendHorizontal className="h-[18px] w-[18px] rtl:-scale-x-100" />
        </button>
      </div>
      {text.length > MAX_MESSAGE_LENGTH - 300 && (
        <p className={cn('px-1.5 pt-1 text-end text-[11px]', text.length > MAX_MESSAGE_LENGTH ? 'text-rose-600' : 'text-slate-400')}>
          {text.length}/{MAX_MESSAGE_LENGTH}
        </p>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────

export interface PanelProps {
  dir?: 'ltr' | 'rtl';
  config: WidgetConfig;
  strings: WidgetStrings;
  lang: WidgetLang;
  conversation: WidgetConversation | null;
  messages: WidgetMessage[];
  streamingText: string | null;
  /** Tool activity while the reply is being prepared. */
  streamingStatus?: 'searching' | 'working' | null;
  awaitingReply: boolean;
  agentTyping?: string | null;
  connection: 'connected' | 'reconnecting';
  expanded: boolean;
  canExpand: boolean;
  fullscreen: boolean;
  loading?: boolean;
  error?: string | null;
  onClose?: () => void;
  onToggleExpand?: () => void;
  onSend: (text: string, attachments: UploadReceipt[]) => void;
  onRetry?: (message: WidgetMessage) => void;
  onRestart?: () => void;
  onHandoff?: () => void;
  upload?: (file: File) => Promise<UploadReceipt>;
}

export function Panel(props: PanelProps) {
  const { config, strings, lang, conversation, fullscreen } = props;
  return (
    <section
      dir={props.dir}
      aria-label={config.agentName}
      className={cn(
        'flex h-full w-full flex-col overflow-hidden bg-slate-50',
        fullscreen ? '' : 'rounded-2xl shadow-[0_20px_60px_-15px_rgba(15,23,42,0.45)] ring-1 ring-slate-900/10',
      )}
    >
      <Header
        config={config}
        conversation={conversation}
        strings={strings}
        lang={lang}
        expanded={props.expanded}
        canExpand={props.canExpand}
        onClose={props.onClose}
        onToggleExpand={props.onToggleExpand}
        onRestart={props.onRestart}
        onHandoff={props.onHandoff}
      />
      {conversation?.status === 'WAITING_FOR_AGENT' && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-[12.5px] text-amber-900">
          <Headset className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">{strings.waitingForAgent}</span> {strings.waitingHint}
          </span>
        </div>
      )}
      {props.connection === 'reconnecting' && (
        <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-100 px-4 py-1.5 text-[12px] text-slate-600">
          <WifiOff className="h-3.5 w-3.5" /> {strings.reconnecting}
        </div>
      )}
      {props.loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : props.error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[13px] text-slate-600">
          <AlertCircle className="h-6 w-6 text-slate-400" />
          {props.error}
        </div>
      ) : (
        <MessageList
          config={config}
          messages={props.messages}
          streamingText={props.streamingText}
          streamingStatus={props.streamingStatus}
          awaitingReply={props.awaitingReply}
          agentTyping={props.agentTyping}
          strings={strings}
          lang={lang}
          onQuickReply={(q) => (isHandoffPhrase(q) && props.onHandoff ? props.onHandoff() : props.onSend(q, []))}
          onAction={(a) => (a === 'handoff' ? props.onHandoff?.() : props.onRestart?.())}
          onRetry={props.onRetry}
        />
      )}
      <Composer
        strings={strings}
        allowAttachments={config.allowAttachments}
        disabled={props.loading || Boolean(props.error)}
        onSend={props.onSend}
        upload={props.upload}
        autoFocus={!fullscreen}
      />
      <p className="bg-white pb-2 text-center text-[10.5px] text-slate-400">
        {strings.poweredBy} <span className="font-semibold text-slate-500">OmniAI</span>
      </p>
    </section>
  );
}
