'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNowStrict } from 'date-fns';
import { Bell, CheckCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const POLL_MS = 30_000;

export function NotificationBell() {
  const [data, setData] = useState<{ unread: number; items: NotificationItem[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ data: { unread: number; items: NotificationItem[] } }>('/api/v1/notifications');
      setData(res.data);
    } catch {
      /* keep the last state */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function markRead(body: { all: true } | { ids: string[] }) {
    try {
      const res = await api<{ data: { unread: number; items: NotificationItem[] } }>('/api/v1/notifications', { method: 'PATCH', json: body });
      setData(res.data);
    } catch {
      /* ignore */
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) void load();
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${data.unread ? ` (${data.unread} unread)` : ''}`}>
          <Bell className="h-[18px] w-[18px]" />
          {data.unread > 0 && (
            <span className="absolute end-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
              {data.unread > 9 ? '9+' : data.unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="text-sm font-semibold">Notifications</p>
          {data.unread > 0 && (
            <button type="button" onClick={() => markRead({ all: true })} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <CheckCheck className="h-3.5 w-3.5" /> Mark all read
            </button>
          )}
        </div>
        <div className="max-h-[24rem] overflow-y-auto">
          {data.items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">You’re all caught up.</p>
          ) : (
            data.items.map((n) => {
              const content = (
                <div className={cn('border-b px-4 py-3 text-start last:border-0 hover:bg-muted/50', !n.read && 'bg-primary/[0.04]')}>
                  <div className="flex items-start gap-2">
                    {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{n.title}</p>
                      {n.body && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">{n.body}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground" suppressHydrationWarning>
                        {formatDistanceToNowStrict(new Date(n.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                </div>
              );
              const onClick = () => {
                if (!n.read) void markRead({ ids: [n.id] });
                setOpen(false);
              };
              return n.link ? (
                <Link key={n.id} href={n.link} onClick={onClick} className="block">
                  {content}
                </Link>
              ) : (
                <button key={n.id} type="button" onClick={onClick} className="block w-full">
                  {content}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
