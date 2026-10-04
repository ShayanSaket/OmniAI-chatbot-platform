'use client';

import { ArrowLeft, Bot, CheckCircle2, Hand, Loader2, MoreVertical, PanelRight, RotateCcw, UserPlus, UserRound, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { customerDisplayName, type InboxConversationDetail, type InboxMember } from '@/lib/inbox';
import { ChannelIcon, CustomerAvatar, StatusPill } from './shared';

export type ThreadAction = 'take-over' | 'return-to-ai' | 'close' | 'reopen';

interface Props {
  conversation: InboxConversationDetail;
  members: InboxMember[];
  meId: string;
  canReply: boolean;
  canManage: boolean;
  busy: ThreadAction | 'assign' | null;
  onAction: (action: ThreadAction) => void;
  onAssign: (userId: string | null) => void;
  onBack: () => void;
  onToggleDetails: () => void;
}

const REASON: Record<string, string> = {
  button: 'tapped “Talk to a human”',
  customer_request: 'asked for a person',
  ai_failure: 'the AI could not answer',
  ai_escalation: 'the AI escalated it',
  rule: 'an escalation rule matched',
  automation: 'an automation handed it over',
  angry: 'the customer seems angry or frustrated',
  complaint: 'serious complaint',
  legal: 'legal or privacy request',
  payment: 'payment or billing problem',
  technical: 'complex technical issue',
  safety: 'safety or emergency concern',
};

export function ThreadHeader({ conversation: c, members, meId, canReply, canManage, busy, onAction, onAssign, onBack, onToggleDetails }: Props) {
  const name = customerDisplayName(c.customer);
  const assignedToMe = c.assignedTo?.id === meId;
  const reason = c.handoffReason ? (REASON[c.handoffReason] ?? c.handoffReason.replace(/_/g, ' ')) : null;

  return (
    <div className="border-b bg-background">
      <div className="flex items-center gap-2 px-2 py-2 sm:px-4">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 md:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <CustomerAvatar customer={c.customer} size={36} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold" dir="auto">
            {name}
          </h2>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <ChannelIcon channel={c.channel} className="h-3 w-3 shrink-0" />
            <span className="shrink-0">{c.channel === 'WHATSAPP' ? 'WhatsApp' : 'Website'}</span>
            <StatusPill status={c.status} />
            {c.assignedTo && (
              <span className="hidden min-w-0 items-center gap-1 truncate sm:inline-flex">
                <UserRound className="h-3 w-3 shrink-0" />
                <span className="truncate">{assignedToMe ? 'You' : (c.assignedTo.name ?? 'Team member')}</span>
              </span>
            )}
          </div>
        </div>

        {canReply && (c.status === 'AI_ACTIVE' || c.status === 'WAITING_FOR_AGENT') && (
          <Button size="sm" onClick={() => onAction('take-over')} disabled={busy !== null} className="shrink-0">
            {busy === 'take-over' ? <Loader2 className="h-4 w-4 animate-spin sm:me-1.5" /> : <Hand className="h-4 w-4 sm:me-1.5" />}
            <span className="hidden sm:inline">Take over</span>
          </Button>
        )}
        {canReply && c.status === 'HUMAN_ACTIVE' && (
          <Button size="sm" variant="outline" onClick={() => onAction('return-to-ai')} disabled={busy !== null} className="shrink-0">
            {busy === 'return-to-ai' ? <Loader2 className="h-4 w-4 animate-spin sm:me-1.5" /> : <Bot className="h-4 w-4 sm:me-1.5" />}
            <span className="hidden sm:inline">Return to AI</span>
          </Button>
        )}

        {canReply && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Conversation actions" disabled={busy !== null}>
                {busy === 'assign' || busy === 'close' || busy === 'reopen' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {canManage ? (
                <>
                  <DropdownMenuLabel className="text-xs">Assign to</DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={c.assignedTo?.id ?? 'none'} onValueChange={(v) => onAssign(v === 'none' ? null : v)}>
                    <DropdownMenuRadioItem value="none">Unassigned</DropdownMenuRadioItem>
                    {members.map((m) => (
                      <DropdownMenuRadioItem key={m.id} value={m.id}>
                        <span className="truncate">{m.id === meId ? `${m.name ?? m.email} (you)` : (m.name ?? m.email)}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </>
              ) : assignedToMe ? (
                <DropdownMenuItem onSelect={() => onAssign(null)}>
                  <UserX className="me-2 h-4 w-4" /> Unassign me
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onAssign(meId)}>
                  <UserPlus className="me-2 h-4 w-4" /> Assign to me
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {c.status === 'CLOSED' ? (
                <DropdownMenuItem onSelect={() => onAction('reopen')}>
                  <RotateCcw className="me-2 h-4 w-4" /> Reopen conversation
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onAction('close')}>
                  <CheckCircle2 className="me-2 h-4 w-4" /> Close conversation
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 xl:hidden" onClick={onToggleDetails} aria-label="Customer details">
          <PanelRight className="h-4 w-4" />
        </Button>
      </div>

      {c.status === 'WAITING_FOR_AGENT' && (
        <div className="flex items-center gap-2 border-t border-amber-500/20 bg-amber-500/[0.08] px-4 py-2 text-[13px] text-amber-900 dark:text-amber-200" role="status">
          <Hand className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">
            Waiting for a team member{reason ? ` — ${reason}` : ''}. The AI has stopped replying.
          </span>
        </div>
      )}
      {c.status === 'AI_ACTIVE' && c.handoffRequestedAt && (
        <div className="flex items-center gap-2 border-t bg-muted/50 px-4 py-2 text-[13px] text-muted-foreground" role="status">
          <Hand className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">Follow-up requested while the team was offline{reason ? ` (${reason})` : ''}. The AI is still helping.</span>
        </div>
      )}
    </div>
  );
}
