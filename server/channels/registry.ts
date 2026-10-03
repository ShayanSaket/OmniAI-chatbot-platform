import 'server-only';
import type { ChannelType } from '@prisma/client';
import type { ChannelAdapter } from './types';
import { websiteChannelAdapter } from './website/adapter';
import { whatsappChannelAdapter } from './whatsapp/adapter';

// Register new channels here (Instagram, Messenger, Telegram, SMS, email later).
// Everything else resolves adapters through this function.
const ADAPTERS: Partial<Record<ChannelType, ChannelAdapter<never>>> = {
  WEBSITE: websiteChannelAdapter as ChannelAdapter<never>,
  WHATSAPP: whatsappChannelAdapter as ChannelAdapter<never>,
};

export function getChannelAdapter(type: ChannelType): ChannelAdapter<never> {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`No channel adapter registered for ${type}`);
  return adapter;
}
