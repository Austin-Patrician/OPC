import React, { useState } from "react"
import {
  Check,
  MessageCircle,
  Minus,
  Plus,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { BuddyCreation, BuddyMemory, BuddyTask } from "../types/chat"
import { BuddyAvatar, LandscapeIllustration } from "./BuddyAvatar"

const WindowTopControls: React.FC = () => (
  <header className="h-[46px] px-6 flex items-center justify-end gap-3.5 text-[#4A5550] shrink-0 select-none">
    <Minus className="w-[16px] h-[16px]" strokeWidth={1.7} />
    <Square className="w-[13px] h-[13px]" strokeWidth={1.7} />
    <X className="w-[16px] h-[16px]" strokeWidth={1.7} />
  </header>
)

/* -------------------------------------------------------------------------- */
/* 1. Tasks View (Checkmark Square Icon)                                      */
/* -------------------------------------------------------------------------- */
export const TasksView: React.FC<{
  tasks: BuddyTask[]
  onToggleTask: (id: string) => void
  onAddTask: (title: string) => void
  onAskBuddy: (prompt: string) => void
}> = ({ tasks, onToggleTask, onAddTask, onAskBuddy }) => {
  const [draft, setDraft] = useState("")

  const submit = () => {
    if (!draft.trim()) return
    onAddTask(draft.trim())
    setDraft("")
  }

  const pending = tasks.filter((t) => !t.done)
  const completed = tasks.filter((t) => t.done)

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#FAFCFB]/90">
      <WindowTopControls />

      <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-8">
        <div className="max-w-[780px] mx-auto space-y-6">
          {/* Header */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <BuddyAvatar size="sm" showSpark={false} />
              <div>
                <h1 className="text-[17px] font-bold text-[#18221E]">
                  交代给 Buddy 的事
                </h1>
                <p className="text-[12.5px] text-[#7A8781]">
                  你在聊天里随口交代的事，Buddy 会自动记在这里并跟进完成
                </p>
              </div>
            </div>
            <span className="px-3 py-1 rounded-full bg-[#E3F3E9] text-[#1F7A46] text-[12px] font-medium">
              已完成 {completed.length} / {tasks.length}
            </span>
          </div>

          {/* Quick Add Bar */}
          <div className="bg-white rounded-[14px] border border-[#EBF0ED] shadow-[0_4px_16px_rgba(18,38,28,0.03)] p-2 pl-4 flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit()
              }}
              placeholder="记一件想让 Buddy 办的事，回车添加..."
              className="flex-1 bg-transparent outline-none text-[13.5px] text-[#1E2E26] placeholder:text-[#98A6A0]"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              className="h-8 px-3.5 rounded-[10px] bg-[#22B560] hover:bg-[#1CA354] text-white text-[12.5px] font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>添加</span>
            </button>
          </div>

          {/* Pending List */}
          {pending.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-[12px] font-semibold text-[#6C7A74] px-1">
                正在跟进 ({pending.length})
              </div>
              {pending.map((task) => (
                <div
                  key={task.id}
                  className="bg-white rounded-[14px] border border-[#EEF2F0] shadow-[0_4px_18px_rgba(18,38,28,0.035)] px-4 py-3.5 flex items-center justify-between gap-4"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => onToggleTask(task.id)}
                      className="mt-0.5 w-5 h-5 rounded-full border-2 border-[#B8CEC2] hover:border-[#22B560] transition-colors cursor-pointer shrink-0"
                      title="标记为完成"
                    />
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-[#1E2E26]">
                        {task.title}
                      </div>
                      <div className="text-[12px] text-[#7A8781] mt-0.5">
                        {task.note}
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onAskBuddy(`帮我跟进一下这件事：${task.title}`)}
                    className="h-7 px-3 rounded-[9px] bg-[#EEF8F2] hover:bg-[#E1F4E8] text-[#1F7A46] text-[12px] font-medium flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>让 Buddy 办</span>
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Completed List */}
          {completed.length > 0 && (
            <div className="space-y-2.5">
              <div className="text-[12px] font-semibold text-[#6C7A74] px-1">
                已办妥 ({completed.length})
              </div>
              {completed.map((task) => (
                <div
                  key={task.id}
                  className="bg-white/80 rounded-[14px] border border-[#EFF3F1] px-4 py-3.5 flex items-center justify-between gap-4"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => onToggleTask(task.id)}
                      className="mt-0.5 w-5 h-5 rounded-full bg-[#22B560] text-white flex items-center justify-center shrink-0 cursor-pointer"
                      title="取消完成状态"
                    >
                      <Check className="w-3 h-3" strokeWidth={3} />
                    </button>
                    <div className="min-w-0">
                      <div className="text-[14px] font-medium text-[#5A6862] line-through">
                        {task.title}
                      </div>
                      <div className="text-[12px] text-[#8F9C96] mt-0.5">
                        {task.note}
                      </div>
                    </div>
                  </div>
                  <span className="text-[11.5px] text-[#8F9C96] shrink-0">
                    {task.updatedAt}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* 2. Gallery / Creations View (2x2 Grid Icon)                                */
/* -------------------------------------------------------------------------- */
export const GalleryView: React.FC<{
  creations: BuddyCreation[]
  onAskBuddy: (prompt: string) => void
}> = ({ creations, onAskBuddy }) => {
  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#FAFCFB]/90">
      <WindowTopControls />

      <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-8">
        <div className="max-w-[780px] mx-auto space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <BuddyAvatar size="sm" showSpark={false} />
              <div>
                <h1 className="text-[17px] font-bold text-[#18221E]">
                  成果与百宝箱
                </h1>
                <p className="text-[12.5px] text-[#7A8781]">
                  Buddy 帮你整理的生活随笔、出行指南与思考笔记都在这里
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {creations.map((item) => (
              <div
                key={item.id}
                className="bg-white rounded-[16px] border border-[#EEF2F0] shadow-[0_6px_22px_rgba(18,38,28,0.04)] p-4 flex flex-col justify-between gap-3.5"
              >
                <div className="space-y-3">
                  {item.useIllustration ? (
                    <LandscapeIllustration className="w-full h-[148px]" />
                  ) : (
                    <img
                      src={item.previewUrl}
                      alt={item.title}
                      className="w-full h-[148px] rounded-[11px] object-cover border border-black/[0.04]"
                    />
                  )}
                  <div>
                    <div className="text-[14.5px] font-semibold text-[#18221E]">
                      {item.title}
                    </div>
                    <div className="text-[12px] text-[#7A8781] mt-0.5">
                      {item.subtitle}
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-[#F2F5F3] flex items-center justify-between">
                  <div className="bg-[#EEF8F2] rounded-[8px] px-2.5 py-1 inline-flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-[#22B560] text-white flex items-center justify-center">
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                    </span>
                    <span className="text-[11.5px] font-medium text-[#1F7A46]">
                      {item.statusText}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      onAskBuddy(`参考《${item.title}》的风格，再帮我做一版新的`)
                    }
                    className="text-[12px] font-medium text-[#1FA958] hover:underline cursor-pointer"
                  >
                    再做一版
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

/* -------------------------------------------------------------------------- */
/* 3. Memory View (Stacked Layers Icon)                                       */
/* -------------------------------------------------------------------------- */
export const MemoryView: React.FC<{
  memories: BuddyMemory[]
  onToggleMemory: (id: string) => void
  onAddMemory: (content: string) => void
  onDeleteMemory: (id: string) => void
}> = ({ memories, onToggleMemory, onAddMemory, onDeleteMemory }) => {
  const [draft, setDraft] = useState("")

  const add = () => {
    if (!draft.trim()) return
    onAddMemory(draft.trim())
    setDraft("")
  }

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#FAFCFB]/90">
      <WindowTopControls />

      <div className="flex-1 overflow-y-auto px-6 sm:px-10 pb-8">
        <div className="max-w-[780px] mx-auto space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <BuddyAvatar size="sm" showSpark={false} />
              <div>
                <h1 className="text-[17px] font-bold text-[#18221E]">
                  Buddy 记住的偏好
                </h1>
                <p className="text-[12.5px] text-[#7A8781]">
                  平时聊天里提到的习惯和喜好，下次不用重复叮嘱
                </p>
              </div>
            </div>
          </div>

          {/* Add Memory Input */}
          <div className="bg-white rounded-[14px] border border-[#EBF0ED] shadow-[0_4px_16px_rgba(18,38,28,0.03)] p-2 pl-4 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#22B560] shrink-0" />
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add()
              }}
              placeholder="告诉 Buddy 一条你的习惯，例如：字幕一律用纯白无描边..."
              className="flex-1 bg-transparent outline-none text-[13.5px] text-[#1E2E26] placeholder:text-[#98A6A0]"
            />
            <button
              type="button"
              onClick={add}
              disabled={!draft.trim()}
              className="h-8 px-3.5 rounded-[10px] bg-[#22B560] hover:bg-[#1CA354] text-white text-[12.5px] font-medium transition-colors cursor-pointer disabled:opacity-40"
            >
              记住
            </button>
          </div>

          {/* Memory Cards */}
          <div className="space-y-3">
            {memories.map((mem) => (
              <div
                key={mem.id}
                className="bg-white rounded-[14px] border border-[#EEF2F0] shadow-[0_4px_18px_rgba(18,38,28,0.035)] px-4 py-3.5 flex items-center justify-between gap-4"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-[6px] bg-[#EEF8F2] text-[#1F7A46]">
                      {mem.category}
                    </span>
                    <span className="text-[11px] text-[#98A6A0]">
                      {mem.updatedAt}
                    </span>
                  </div>
                  <p
                    className={`text-[14px] leading-relaxed ${
                      mem.active ? "text-[#1E2E26]" : "text-[#98A6A0] line-through"
                    }`}
                  >
                    {mem.content}
                  </p>
                </div>

                <div className="flex items-center gap-2.5 shrink-0">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={mem.active}
                    onClick={() => onToggleMemory(mem.id)}
                    className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${
                      mem.active ? "bg-[#22B560]" : "bg-[#D5DFDA]"
                    }`}
                    title={mem.active ? "已启用" : "已暂停"}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-xs transition-transform ${
                        mem.active ? "translate-x-4" : ""
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteMemory(mem.id)}
                    className="p-1.5 rounded-[8px] text-[#98A6A0] hover:text-[#D93025] hover:bg-black/[0.04] transition-colors cursor-pointer"
                    title="删除这条记忆"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}
