import { Globe, Mail, MessageCircle, MessageSquare, Send, type LucideIcon } from 'lucide-react';
import type { ChannelType, ConversationStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const CHANNELS: Record<ChannelType, { label: string; icon: LucideIcon; className: string }> = {
  WEBSITE: { label: 'Website', icon: Globe, className: 'text-[hsl(var(--chart-1))]' },
  WHATSAPP: { label: 'WhatsApp', icon: MessageCircle, className: 'text-[hsl(var(--chart-2))]' },
  INSTAGRAM: { label: 'Instagram', icon: MessageSquare, className: 'text-muted-foreground' },
  MESSENGER: { label: 'Messenger', icon: MessageSquare, className: 'text-muted-foreground' },
  TELEGRAM: { label: 'Telegram', icon: Send, className: 'text-muted-foreground' },
  EMAIL: { label: 'Email', icon: Mail, className: 'text-muted-foreground' },
  SMS: { label: 'SMS', icon: MessageSquare, className: 'text-muted-foreground' },
};

export function ChannelBadge({ channel }: { channel: ChannelType }) {
  const c = CHANNELS[channel];
  const Icon = c.icon;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className={cn('h-3.5 w-3.5', c.className)} aria-hidden />
      {c.label}
    </span>
  );
}

const STATUS: Record<ConversationStatus, { label: string; className: string; dot: string }> = {
  AI_ACTIVE: { label: 'AI active', className: 'bg-accent text-accent-foreground', dot: 'bg-primary' },
  WAITING_FOR_AGENT: { label: 'Waiting for agent', className: 'bg-warning/10 text-amber-700 dark:text-amber-400', dot: 'bg-warning' },
  HUMAN_ACTIVE: { label: 'Human active', className: 'bg-success/10 text-success', dot: 'bg-success' },
  CLOSED: { label: 'Closed', className: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground/60' },
};

export function StatusBadge({ status }: { status: ConversationStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', s.className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden />
      {s.label}
    </span>
  );
}

export const STATUS_LABEL: Record<ConversationStatus, string> = Object.fromEntries(
  Object.entries(STATUS).map(([k, v]) => [k, v.label]),
) as Record<ConversationStatus, string>;
