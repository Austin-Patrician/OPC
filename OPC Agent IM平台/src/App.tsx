import React, { useCallback, useRef, useState } from "react"
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
import { SettingsView } from "./components/settings/SettingsView"

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

/** Rough "human" typing time for a message. */
const typingTime = (text: string) => Math.min(2200, 600 + text.length * 22)

let idSeq = 0
const nextId = () => `msg-${Date.now()}-${idSeq++}`

export default function App() {
  const [view, setView] = useState<View>("chat")
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

  return (
    <div className="h-screen w-screen overflow-hidden flex items-center justify-center p-0 sm:p-4 md:p-6 relative bg-[#DFEBF6] text-[#1D1D1F]">
      {/* Soft diagonal pastel backdrop matching the uploaded reference image */}
      <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(135deg, #D9E9F9 0%, #E7EFFA 38%, #D8EFE3 72%, #E2E7FA 100%)",
          }}
        />
        <div className="absolute -top-24 right-[12%] w-[560px] h-[420px] rounded-full bg-[#CCEAD9]/65 blur-[90px]" />
        <div className="absolute -bottom-24 left-[18%] w-[540px] h-[400px] rounded-full bg-[#F7F9FC]/80 blur-[90px]" />
      </div>

      {/* Main Floating Frosted Window matching the attachment */}
      <div className="relative z-10 w-full h-full max-w-[1220px] max-h-[820px] bg-[#FAFCFB]/95 backdrop-blur-2xl sm:rounded-[18px] border border-white/90 shadow-[0_24px_70px_rgba(25,50,75,0.09),0_2px_10px_rgba(0,0,0,0.03)] flex overflow-hidden">
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
        {view === "settings" && <SettingsView />}
      </div>
    </div>
  )
}
