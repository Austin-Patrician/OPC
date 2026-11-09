import React, { Suspense, lazy, useCallback, useRef, useState } from "react"
import {
  ASSISTANT_NAME,
  INITIAL_CREATIONS,
  INITIAL_MEMORIES,
  INITIAL_MESSAGES,
  INITIAL_TASKS,
} from "./data/conversation"
import { ReplyItem, replyTo } from "./data/replies"
import {
  BuddyCreation,
  BuddyMemory,
  BuddyTask,
  ChatMessage,
  View,
} from "./types/chat"
import { LeftRail } from "./components/LeftRail"
import { ChatView } from "./components/ChatView"
import { GalleryView, MemoryView, TasksView } from "./components/SidebarViews"
// The 3D observatory pulls in three.js; load it only when that view is opened.
const SystemRuntimeView = lazy(() =>
  import("./components/runtime/SystemRuntimeView").then((m) => ({ default: m.SystemRuntimeView })),
)
import { SettingsView } from "./components/settings/SettingsView"

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** Rough "human" typing time for a message. */
const typingTime = (text: string) => Math.min(2200, 600 + text.length * 22)

let idSeq = 0
const nextId = () => `msg-${Date.now()}-${idSeq++}`

export default function App() {
  // Default to "runtime" so the System Runtime observatory opens immediately
  const [view, setView] = useState<View>("runtime")
  // Start in the first-time empty state so the user immediately sees the welcome window;
  // they can click any starter card, send a message, or click "查看对话示例" in the top bar.
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [tasks, setTasks] = useState<BuddyTask[]>(INITIAL_TASKS)
  const [creations] = useState<BuddyCreation[]>(INITIAL_CREATIONS)
  const [memories, setMemories] = useState<BuddyMemory[]>(INITIAL_MEMORIES)
  const [typing, setTyping] = useState(false)
  // Serialises assistant replies so overlapping sends never interleave.
  const replyQueue = useRef<Promise<void>>(Promise.resolve())

  const appendItem = (from: ChatMessage["from"], item: ReplyItem) =>
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        from,
        at: Date.now(),
        ...item,
      },
    ])

  const speak = useCallback((items: ReplyItem[], leadIn: number) => {
    replyQueue.current = replyQueue.current.then(async () => {
      await sleep(leadIn)
      setTyping(true)
      for (const item of items) {
        await sleep(typingTime(item.text))
        appendItem("assistant", item)
      }
      setTyping(false)
    })
  }, [])

  const handleSend = (text: string) => {
    appendItem("me", { text })
    const reply = replyTo(text)
    speak(reply.messages, 500)
    if (reply.followUp) {
      const { delayMs, messages: later } = reply.followUp
      window.setTimeout(() => speak(later, 0), delayMs)
    }
  }

  const handleAskBuddyFromSidebar = (prompt: string) => {
    setView("chat")
    handleSend(prompt)
  }

  const handleToggleTask = (id: string) => {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, done: !t.done, updatedAt: !t.done ? "刚刚完成" : "待办" }
          : t,
      ),
    )
  }

  const handleAddTask = (title: string) => {
    setTasks((prev) => [
      {
        id: `task-${Date.now()}`,
        title,
        note: "Buddy 已记录，随时可以在对话里推进",
        done: false,
        updatedAt: "刚刚添加",
      },
      ...prev,
    ])
  }

  const handleToggleMemory = (id: string) => {
    setMemories((prev) =>
      prev.map((m) => (m.id === id ? { ...m, active: !m.active } : m)),
    )
  }

  const handleAddMemory = (content: string) => {
    setMemories((prev) => [
      {
        id: `mem-${Date.now()}`,
        category: "新增偏好",
        content,
        active: true,
        updatedAt: "刚刚记住",
      },
      ...prev,
    ])
  }

  const handleDeleteMemory = (id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id))
  }

  const pendingTaskCount = tasks.filter((t) => !t.done).length
  const isRuntime = view === "runtime"

  return (
    <div
      className={`h-screen w-screen overflow-hidden flex items-center justify-center relative text-[#18181B] ${
        isRuntime ? "p-0 bg-[#EAECE8]" : "p-0 sm:p-3 md:p-5 bg-[#EBEFEA]"
      }`}
    >
      {/* Desktop Electron Application Frame (1440 x 1024 target, solid surfaces, max 8px radius in runtime) */}
      <div
        className={`relative z-10 w-full h-full flex overflow-hidden ${
          isRuntime
            ? "max-w-[1440px] max-h-[1024px] bg-[#F3F4F1] sm:rounded-[8px] border border-[#D4D6D2] shadow-[0_2px_10px_rgba(0,0,0,0.05)]"
            : "max-w-[1260px] max-h-[860px] bg-[#FAFCFB] sm:rounded-[14px] border border-[#E2E6E3] shadow-[0_12px_40px_rgba(20,35,30,0.06)]"
        }`}
      >
        <LeftRail
          view={view}
          onChangeView={setView}
          assistantName={ASSISTANT_NAME}
          pendingTaskCount={pendingTaskCount}
        />

        {view === "chat" && (
          <ChatView
            messages={messages}
            typing={typing}
            onSend={handleSend}
            onLoadSampleConversation={() => setMessages(INITIAL_MESSAGES)}
            onResetToEmpty={() => setMessages([])}
          />
        )}
        {view === "tasks" && (
          <TasksView
            tasks={tasks}
            onToggleTask={handleToggleTask}
            onAddTask={handleAddTask}
            onAskBuddy={handleAskBuddyFromSidebar}
          />
        )}
        {view === "gallery" && (
          <GalleryView
            creations={creations}
            onAskBuddy={handleAskBuddyFromSidebar}
          />
        )}
        {view === "memory" && (
          <MemoryView
            memories={memories}
            onToggleMemory={handleToggleMemory}
            onAddMemory={handleAddMemory}
            onDeleteMemory={handleDeleteMemory}
          />
        )}
        {view === "runtime" && (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center bg-[#F2EEE7] font-mono text-[11px] uppercase tracking-[0.18em] text-[#9A9389]">
                Loading runtime…
              </div>
            }
          >
            <SystemRuntimeView />
          </Suspense>
        )}
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  )
}
