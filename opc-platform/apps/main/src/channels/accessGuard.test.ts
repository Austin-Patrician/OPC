import { describe, expect, it } from 'vitest';
import type { ChannelAccessConfig } from '@opc/shared/domain';
import { evaluateChannelAccess } from './accessGuard';

const BASE_ACCESS: ChannelAccessConfig = {
  dmPolicy: 'pairing',
  dmAllowlist: ['ou_trusted'],
  groupPolicy: 'mention',
  groupAllowlist: ['oc_vip_group'],
};

describe('evaluateChannelAccess', () => {
  it('ignores self or bot messages in all modes', () => {
    const decision = evaluateChannelAccess(
      {
        isBotSender: true,
        chatKind: 'p2p',
        senderId: 'ou_trusted',
        chatId: 'oc_1',
        mentionsBot: true,
      },
      { ...BASE_ACCESS, dmPolicy: 'open', groupPolicy: 'open' },
    );
    expect(decision).toEqual({ action: 'ignore', reason: 'bot_or_self_message' });
  });

  it('requires pairing for unknown DM senders when dmPolicy is pairing', () => {
    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'p2p',
          senderId: 'ou_stranger',
          chatId: 'oc_dm',
          mentionsBot: true,
        },
        BASE_ACCESS,
      ),
    ).toEqual({ action: 'pair', reason: 'dm_pairing_required' });
  });

  it('allows allowlisted DM senders under pairing and allowlist policies', () => {
    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'p2p',
          senderId: 'ou_trusted',
          chatId: 'oc_dm',
          mentionsBot: true,
        },
        { ...BASE_ACCESS, dmPolicy: 'allowlist' },
      ),
    ).toEqual({ action: 'allow' });
  });

  it('silently ignores unknown DM senders when dmPolicy is allowlist', () => {
    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'p2p',
          senderId: 'ou_stranger',
          chatId: 'oc_dm',
          mentionsBot: true,
        },
        { ...BASE_ACCESS, dmPolicy: 'allowlist' },
      ),
    ).toEqual({ action: 'ignore', reason: 'dm_not_in_allowlist' });
  });

  it('enforces @mention requirement in group mention mode', () => {
    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'group',
          senderId: 'ou_trusted',
          chatId: 'oc_any',
          mentionsBot: false,
        },
        BASE_ACCESS,
      ),
    ).toEqual({ action: 'ignore', reason: 'group_mention_required' });

    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'group',
          senderId: 'ou_trusted',
          chatId: 'oc_any',
          mentionsBot: true,
        },
        BASE_ACCESS,
      ),
    ).toEqual({ action: 'allow' });
  });

  it('enforces groupAllowlist and disabled policies', () => {
    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'group',
          senderId: 'ou_any',
          chatId: 'oc_vip_group',
          mentionsBot: false,
        },
        { ...BASE_ACCESS, groupPolicy: 'allowlist' },
      ),
    ).toEqual({ action: 'allow' });

    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'group',
          senderId: 'ou_any',
          chatId: 'oc_other_group',
          mentionsBot: true,
        },
        { ...BASE_ACCESS, groupPolicy: 'allowlist' },
      ),
    ).toEqual({ action: 'ignore', reason: 'group_not_in_allowlist' });

    expect(
      evaluateChannelAccess(
        {
          isBotSender: false,
          chatKind: 'group',
          senderId: 'ou_any',
          chatId: 'oc_vip_group',
          mentionsBot: true,
        },
        { ...BASE_ACCESS, groupPolicy: 'disabled' },
      ),
    ).toEqual({ action: 'ignore', reason: 'group_disabled' });
  });
});
