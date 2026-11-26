export type BuddySignal =
  | { kind: 'typing' }
  | { kind: 'file-drag'; active: boolean }
  | { kind: 'file-drop' }
  | { kind: 'sent' }
  | { kind: 'brand-summon' }
  | { kind: 'quote'; text: string }
  | { kind: 'voice'; state: 'idle' | 'recording' | 'transcribing'; level?: number }
  | { kind: 'tts'; speaking: boolean };

const bus = new EventTarget();
const EVENT_NAME = 'buddy:signal';

export function emitBuddySignal(signal: BuddySignal): void {
  bus.dispatchEvent(new CustomEvent<BuddySignal>(EVENT_NAME, { detail: signal }));
}

export function subscribeBuddySignal(listener: (signal: BuddySignal) => void): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<BuddySignal>).detail);
  };
  bus.addEventListener(EVENT_NAME, handler);
  return () => bus.removeEventListener(EVENT_NAME, handler);
}
