import { NextResponse } from 'next/server';
import { requireApiAuth } from '@/server/auth/session';
import { AppError } from '@/server/errors';
import { route } from '@/server/http';
import {
  closeConversation,
  markConversationRead,
  refreshConversationSummary,
  reopenConversation,
  returnConversationToAi,
  sendAgentTyping,
  takeOverConversation,
} from '@/server/modules/inbox/inbox-service';

type Params = { conversationId: string; action: string };

const ACTIONS = {
  'take-over': takeOverConversation,
  'return-to-ai': returnConversationToAi,
  close: closeConversation,
  reopen: reopenConversation,
  read: markConversationRead,
  typing: sendAgentTyping,
  summary: refreshConversationSummary,
} as const;

/**
 * POST /conversations/:id/take-over · return-to-ai · close · reopen · read · typing · summary
 * Permissions are enforced by each service function.
 */
export const POST = route<Params>(async (_req, { params }) => {
  const ctx = await requireApiAuth('inbox:access');
  if (!Object.hasOwn(ACTIONS, params.action)) throw new AppError('NOT_FOUND', 'Unknown action.');
  const action = ACTIONS[params.action as keyof typeof ACTIONS];
  return NextResponse.json({ data: await action(ctx, params.conversationId) });
});
