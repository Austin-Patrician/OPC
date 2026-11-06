export type View = "chat" | "tasks" | "gallery" | "memory" | "settings"

export interface ChatMessage {
  id: string
  from: "me" | "assistant"
  text: string
  /** Epoch milliseconds. */
  at: number
  /** Optional left-side photo inside an assistant card (matches Card 1 in attachment). */
  imageLeft?: {
    url: string
    alt: string
  }
  /** Optional green check status pill inside an assistant card (matches Card 1 in attachment). */
  statusPill?: string
  /** Optional right-side preview illustration or thumbnail (matches Card 2 in attachment). */
  illustrationRight?: boolean
  imageRightUrl?: string
}

export interface BuddyTask {
  id: string
  title: string
  note: string
  done: boolean
  updatedAt: string
}

export interface BuddyCreation {
  id: string
  title: string
  subtitle: string
  kind: "video" | "cover" | "research"
  previewUrl?: string
  useIllustration?: boolean
  createdAt: string
  statusText: string
}

export interface BuddyMemory {
  id: string
  category: string
  content: string
  active: boolean
  updatedAt: string
}
