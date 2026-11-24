import type { ChatAttachmentRef, ChatContentBlock, Message } from '@opc/shared/domain';

export const INITIAL_FIRST_ITEM_INDEX = 1_000_000;

export interface MessageStreamState {
  messages: Message[];
  firstItemIndex: number;
}

export function isVisibleChatMessage(message: Message): boolean {
  return message.kind !== 'task' && message.kind !== 'deliverable';
}

function areAttachmentsEqual(
  a?: readonly ChatAttachmentRef[],
  b?: readonly ChatAttachmentRef[],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a?.length && !b?.length;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.size !== right.size ||
      left.availability !== right.availability
    ) {
      return false;
    }
  }
  return true;
}

function areContentBlocksEqual(
  a?: readonly ChatContentBlock[],
  b?: readonly ChatContentBlock[],
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a?.length && !b?.length;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]!;
    const right = b[i]!;
    if (left === right) continue;
    if (left.type !== right.type) return false;
    if (left.type === 'markdown' && right.type === 'markdown') {
      if (left.text !== right.text) return false;
      continue;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) return false;
  }
  return true;
}

export function areMessagesEqual(a: Message, b: Message): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.senderId === b.senderId &&
    a.senderName === b.senderName &&
    a.senderRole === b.senderRole &&
    a.senderAvatarUrl === b.senderAvatarUrl &&
    a.timestamp === b.timestamp &&
    a.timeHeader === b.timeHeader &&
    a.text === b.text &&
    a.streaming === b.streaming &&
    areAttachmentsEqual(a.attachments, b.attachments) &&
    areContentBlocksEqual(a.content, b.content)
  );
}

/**
 * Merges incoming snapshot messages into the loaded message list while
 * preserving object references for unchanged items (structural sharing),
 * keeping older paginated history, and removing cancelled transient stream items.
 */
export function mergeSnapshotMessages(current: Message[], incoming: readonly Message[]): Message[] {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const merged: Message[] = [];
  const indexById = new Map<string, number>();

  for (const existing of current) {
    if (existing.streaming === true && !incomingIds.has(existing.id)) {
      continue;
    }
    indexById.set(existing.id, merged.length);
    merged.push(existing);
  }

  for (const next of incoming) {
    const index = indexById.get(next.id);
    if (index === undefined) {
      indexById.set(next.id, merged.length);
      merged.push(next);
    } else {
      const existing = merged[index]!;
      if (!areMessagesEqual(existing, next)) {
        merged[index] = next;
      }
    }
  }

  if (merged.length === current.length && merged.every((message, index) => message === current[index])) {
    return current;
  }
  return merged;
}

/**
 * Prepends an older page of messages and atomically shifts `firstItemIndex`
 * by the exact count of newly added visible items so Virtuoso stays anchored.
 */
export function prependOlderMessages(
  state: MessageStreamState,
  older: readonly Message[],
): MessageStreamState {
  if (older.length === 0) return state;

  const existingById = new Map(state.messages.map((message) => [message.id, message]));
  const dedupedOlder: Message[] = [];
  const seenOlderIds = new Set<string>();
  let addedVisibleCount = 0;

  for (const message of older) {
    if (seenOlderIds.has(message.id)) continue;
    seenOlderIds.add(message.id);
    const existing = existingById.get(message.id);
    if (existing) {
      dedupedOlder.push(existing);
    } else {
      dedupedOlder.push(message);
      if (isVisibleChatMessage(message)) {
        addedVisibleCount += 1;
      }
    }
  }

  const nextMessages = [
    ...dedupedOlder,
    ...state.messages.filter((message) => !seenOlderIds.has(message.id)),
  ];

  if (
    addedVisibleCount === 0 &&
    nextMessages.length === state.messages.length &&
    nextMessages.every((message, index) => message === state.messages[index])
  ) {
    return state;
  }

  return {
    messages: nextMessages,
    firstItemIndex: state.firstItemIndex - addedVisibleCount,
  };
}
