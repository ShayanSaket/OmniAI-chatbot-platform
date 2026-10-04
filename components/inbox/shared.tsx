'use client';

import { useEffect, useState } from 'react';
import { Globe, MessageCircle } from 'lucide-react';
import { customerDisplayName, STATUS_LABEL, type InboxCustomer } from '@/lib/inbox';
import type { ChannelType, ConversationStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

export const CHANNEL_LABEL: Partial<Record<ChannelType, string>> = { WEBSITE: 'Website', WHATSAPP: 'WhatsApp' };

export function ChannelIcon({ channel, className }: { channel: ChannelType; className?: string }) {
  if (channel === 'WHATSAPP') return <MessageCircle className={cn('text-emerald-600 dark:text-emerald-400', className)} aria-label="WhatsApp" />;
  return <Globe className={cn('text-sky-600 dark:text-sky-400', className)} aria-label="Website" />;
}

const STATUS_STYLE: Record<ConversationStatus, string> = {
  AI_ACTIVE: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
  WAITING_FOR_AGENT: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  HUMAN_ACTIVE: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  CLOSED: 'bg-muted text-muted-foreground',
};

export function StatusPill({ status, className }: { status: ConversationStatus; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none', STATUS_STYLE[status], className)}>
      {STATUS_LABEL[status]}
    </span>
  );
}

const AVATAR_COLORS = ['bg-sky-600', 'bg-violet-600', 'bg-emerald-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600', 'bg-fuchsia-600'];

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}

export function CustomerAvatar({ customer, size = 36, className }: { customer: Pick<InboxCustomer, 'id' | 'name' | 'email' | 'phone' | 'avatarUrl'>; size?: number; className?: string }) {
  const name = customerDisplayName(customer);
  const color = AVATAR_COLORS[[...customer.id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
  if (customer.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={customer.avatarUrl} alt="" width={size} height={size} className={cn('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', color, className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name)}
    </span>
  );
}

/** Re-renders every 30 s so relative times stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Compact list time: "now", "5m", "3h", "Mon", "12 Mar". Empty until mounted (no hydration mismatch). */
export function shortTime(iso: string, now: number | null): string {
  if (now === null) return '';
  const t = new Date(iso).getTime();
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 24 * 3_600_000) return `${Math.floor(diff / 3_600_000)}h`;
  const d = new Date(iso);
  if (diff < 6 * 24 * 3_600_000) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function dayLabel(iso: string, now: number | null) {
  const d = new Date(iso);
  if (now !== null) {
    const today = new Date(now);
    const yesterday = new Date(now - 24 * 3_600_000);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  }
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
