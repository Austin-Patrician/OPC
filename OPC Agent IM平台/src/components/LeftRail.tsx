import React from "react"
import { View } from "../types/chat"
import { BuddyAvatar } from "./BuddyAvatar"

interface LeftRailProps {
  view: View
  onChangeView: (view: View) => void
  assistantName: string
  pendingTaskCount?: number
}

export const LeftRail: React.FC<LeftRailProps> = ({
  view,
  onChangeView,
  assistantName,
  pendingTaskCount = 0,
}) => {
  const isRuntime = view === "runtime"

  const navBtnClass = (active: boolean) =>
    `relative w-[42px] h-[42px] ${
      isRuntime ? "rounded-[8px]" : "rounded-[12px]"
    } flex items-center justify-center transition-colors duration-200 cursor-pointer ${
      active
        ? "bg-[#E6F5EC] text-[#16A34A] border border-[#BBF7D0]"
        : "text-[#3E4C46] hover:bg-[#EAECE9]"
    }`

  return (
    <aside className="w-[76px] sm:w-[84px] shrink-0 bg-[#F6F7F5] border-r border-[#E2E4E0] flex flex-col items-center justify-between py-3.5 select-none">
      {/* Top: macOS Traffic Lights + Buddy Identity + 4 Sidebar Icons matching attachment */}
      <div className="flex flex-col items-center">
        {/* macOS Traffic Lights */}
        <div className="flex items-center gap-[7px] mb-4" aria-hidden>
          <span className="w-[11px] h-[11px] rounded-full bg-[#FF5F57] border border-black/[0.06]" />
          <span className="w-[11px] h-[11px] rounded-full bg-[#FEBC2E] border border-black/[0.06]" />
          <span className="w-[11px] h-[11px] rounded-full bg-[#28C840] border border-black/[0.06]" />
        </div>

        {/* Buddy Avatar & Name */}
        <button
          type="button"
          onClick={() => onChangeView("chat")}
          className="flex flex-col items-center group cursor-pointer focus:outline-none"
          title={`与 ${assistantName} 对话`}
        >
          <BuddyAvatar size="md" showSpark />
          <span className="mt-1 text-[13.5px] font-bold text-[#18181B] tracking-tight">
            {assistantName}
          </span>
        </button>

        {/* 4 Primary Sidebar Icons matching the uploaded reference image 1:1 */}
        <nav aria-label="主导航" className="mt-4 flex flex-col items-center gap-2">
          {/* 1. Chat (Green speech bubble with 3 dots) */}
          <button
            type="button"
            onClick={() => onChangeView("chat")}
            aria-current={view === "chat" ? "page" : undefined}
            title="对话"
            aria-label="对话"
            className={navBtnClass(view === "chat")}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3C6.75 3 2.5 6.69 2.5 11.25C2.5 13.73 3.76 15.95 5.75 17.46L4.92 20.38C4.77 20.9 5.31 21.34 5.78 21.08L8.82 19.42C9.83 19.69 10.9 19.84 12 19.84C17.25 19.84 21.5 16.15 21.5 11.59C21.5 7.03 17.25 3 12 3Z"
                fill={view === "chat" ? "#22B560" : "currentColor"}
                fillOpacity={view === "chat" ? "1" : "0.85"}
              />
              <circle cx="8.5" cy="11.5" r="1.3" fill="#FFFFFF" />
              <circle cx="12" cy="11.5" r="1.3" fill="#FFFFFF" />
              <circle cx="15.5" cy="11.5" r="1.3" fill="#FFFFFF" />
            </svg>
          </button>

          {/* 2. Tasks / To-Dos (Rounded square with checkmark) */}
          <button
            type="button"
            onClick={() => onChangeView("tasks")}
            aria-current={view === "tasks" ? "page" : undefined}
            title="交代的事"
            aria-label="交代的事"
            className={navBtnClass(view === "tasks")}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <rect
                x="3.5"
                y="3.5"
                width="17"
                height="17"
                rx="4.2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M8.2 12.3L10.8 14.8L16 9.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {pendingTaskCount > 0 && view !== "tasks" && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#22B560]" />
            )}
          </button>

          {/* 3. Creations & Skills Grid (2x2 rounded squares) */}
          <button
            type="button"
            onClick={() => onChangeView("gallery")}
            aria-current={view === "gallery" ? "page" : undefined}
            title="成果与百宝箱"
            aria-label="成果与百宝箱"
            className={navBtnClass(view === "gallery")}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <rect
                x="3.5"
                y="3.5"
                width="7"
                height="7"
                rx="2.2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <rect
                x="13.5"
                y="3.5"
                width="7"
                height="7"
                rx="2.2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <rect
                x="3.5"
                y="13.5"
                width="7"
                height="7"
                rx="2.2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <rect
                x="13.5"
                y="13.5"
                width="7"
                height="7"
                rx="2.2"
                stroke="currentColor"
                strokeWidth="1.8"
              />
            </svg>
          </button>

          {/* 4. Memory & Preferences (Stacked layers) */}
          <button
            type="button"
            onClick={() => onChangeView("memory")}
            aria-current={view === "memory" ? "page" : undefined}
            title="Buddy 的记忆"
            aria-label="Buddy 的记忆"
            className={navBtnClass(view === "memory")}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3.5L20.5 8.2L12 12.9L3.5 8.2L12 3.5Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <path
                d="M3.5 12.2L12 16.9L20.5 12.2"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M3.5 16.1L12 20.8L20.5 16.1"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {/* 5. System Runtime Observatory (Router · Workers · Watchdog) */}
          <button
            type="button"
            onClick={() => onChangeView("runtime")}
            aria-current={view === "runtime" ? "page" : undefined}
            title="系统运行态 (System Runtime)"
            aria-label="系统运行态 (System Runtime)"
            className={navBtnClass(view === "runtime")}
          >
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
              <rect
                x="3"
                y="4"
                width="18"
                height="16"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M6.5 12.5H9.2L10.8 9L13.2 15L14.8 11.5H17.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-[#16A34A] rt-pulse" />
          </button>
        </nav>
      </div>

      {/* Bottom: User / Settings Button matching attachment */}
      <div className="flex flex-col items-center">
        <button
          type="button"
          onClick={() => onChangeView(view === "settings" ? "chat" : "settings")}
          aria-current={view === "settings" ? "page" : undefined}
          title="个人与设置"
          aria-label="个人与设置"
          className={`w-[40px] h-[40px] ${
            isRuntime ? "rounded-[8px]" : "rounded-[12px]"
          } flex items-center justify-center transition-colors cursor-pointer ${
            view === "settings"
              ? "bg-[#E6F5EC] text-[#16A34A] border border-[#BBF7D0]"
              : "bg-[#EDF1EF] text-[#3E4C46] hover:bg-[#E2EAE6]"
          }`}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="8.5"
              r="3.5"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M5.5 19.5C5.5 16.46 8.41 14 12 14C15.59 14 18.5 16.46 18.5 19.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </aside>
  )
}
