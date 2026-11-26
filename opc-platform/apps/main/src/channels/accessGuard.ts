import type { ChannelAccessConfig } from '@opc/shared/domain';
import type { ChannelInboundMessage } from './types';

export type AccessDecision =
  | { action: 'allow' }
  | { action: 'ignore'; reason: string }
  | { action: 'pair'; reason: string };

/**
 * Pure sender/chat gatekeeping evaluated before an inbound external message is
 * permitted to reach the Router or mirror into desktop chat.
 */
export function evaluateChannelAccess(
  message: Pick<ChannelInboundMessage, 'isBotSender' | 'chatKind' | 'senderId' | 'chatId' | 'mentionsBot'>,
  access: ChannelAccessConfig,
): AccessDecision {
  if (message.isBotSender) {
    return { action: 'ignore', reason: 'bot_or_self_message' };
  }

  if (message.chatKind === 'p2p') {
    if (access.dmPolicy === 'open') {
      return { action: 'allow' };
    }
    if (access.dmAllowlist.includes(message.senderId)) {
      return { action: 'allow' };
    }
    if (access.dmPolicy === 'pairing') {
      return { action: 'pair', reason: 'dm_pairing_required' };
    }
    return { action: 'ignore', reason: 'dm_not_in_allowlist' };
  }

  // Group chat gatekeeping.
  switch (access.groupPolicy) {
    case 'disabled':
      return { action: 'ignore', reason: 'group_disabled' };
    case 'open':
      return { action: 'allow' };
    case 'mention':
      return message.mentionsBot
        ? { action: 'allow' }
        : { action: 'ignore', reason: 'group_mention_required' };
    case 'allowlist':
      return access.groupAllowlist.includes(message.chatId)
        ? { action: 'allow' }
        : { action: 'ignore', reason: 'group_not_in_allowlist' };
  }
}
