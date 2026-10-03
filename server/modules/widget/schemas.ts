import { z } from 'zod';
import { MAX_ATTACHMENTS, MAX_MESSAGE_LENGTH } from '@/lib/widget-protocol';

export const sessionSchema = z.object({
  token: z.string().max(1000).nullish(),
  hostOrigin: z.string().max(300).nullish(),
  pageUrl: z.string().max(2000).nullish(),
  locale: z.string().max(35).optional(),
});

export const uploadReceiptSchema = z.object({
  key: z.string().min(1).max(500),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().positive(),
  sig: z.string().min(10).max(200),
});

export const sendMessageSchema = z
  .object({
    clientMessageId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid message id'),
    content: z.string().max(MAX_MESSAGE_LENGTH, `Messages can be at most ${MAX_MESSAGE_LENGTH} characters`).default(''),
    attachments: z.array(uploadReceiptSchema).max(MAX_ATTACHMENTS).default([]),
    pageUrl: z.string().max(2000).optional(),
  })
  .refine((v) => v.content.trim().length > 0 || v.attachments.length > 0, { message: 'Message is empty', path: ['content'] });
