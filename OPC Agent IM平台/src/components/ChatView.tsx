import React, { useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  ArrowUp,
  Check,
  ChevronDown,
  MessageCircle,
  Mic,
  Minus,
  Paperclip,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Volume2,
  X,
} from "lucide-react"
import { ChatMessage } from "../types/chat"
import { BuddyAvatar, LandscapeIllustration, UserAvatar } from "./BuddyAvatar"
import {
  DigestBadgeIcon,
  InspirationBadgeIcon,
  PlannerBadgeIcon,
} from "./CustomBadgeIcons"
import { useSettings } from "./settings/settingsStore"

interface ChatViewProps {
  messages: ChatMessage[]
  typing: boolean
  onSend: (text: string) => void
  onLoadSampleConversation: () => void
  onResetToEmpty: () => void
}

const TEXT_SIZE = {
  small: "text-[13px]",
  standard: "text-[14px]",
  large: "text-[16px]",
} as const

const URL_PATTERN = /(https?:\/\/[^\s]+)/g

const Linkified: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(URL_PATTERN).map((part, i) =>
      i % 2 === 1 ? (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noreferrer"
          className="text-[#1D9B52] underline underline-offset-2 break-all hover:text-[#157A3F]"
        >
          {part}
        </a>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    )}
  </>
)

export const ChatView: React.FC<ChatViewProps> = ({
  messages,
  typing,
  onSend,
  onLoadSampleConversation,
  onResetToEmpty,
}) => {
  const { prefs } = useSettings()
  const [draft, setDraft] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [isRecording, setIsRecording] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const textSize = TEXT_SIZE[prefs.textSize]
  const isEmpty = messages.length === 0 && !typing

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [messages.length, typing])

  // Simulated voice timer when recording
  useEffect(() => {
    if (!isRecording) {
      setRecordingSeconds(0)
      return
    }
    const timer = window.setInterval(() => {
      setRecordingSeconds((s) => s + 1)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  const send = () => {
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft("")
    inputRef.current?.focus()
  }

  // Handle voice recording trigger & automatic transcription send
  const handleToggleVoice = () => {
    if (!isRecording) {
      setIsRecording(true)
    } else {
      // Stop and finish sending transcribed voice
      setIsRecording(false)
      const sampleVoicePrompts = [
        "帮我梳理一下今天待办的轻重缓急，安排一个松弛的工作节奏",
        "总结一下我们最近讨论的几个核心结论，提炼成 3 条行动建议",
        "给下周的项目沟通起草一份简短明了的要点提纲，语气亲和一点",
      ]
      const transcribed =
        sampleVoicePrompts[
          Math.floor(Math.random() * sampleVoicePrompts.length)
        ]
      onSend(transcribed)
    }
  }

  const handleCancelVoice = () => {
    setIsRecording(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return
    const withMod = e.metaKey || e.ctrlKey
    const shouldSend = prefs.sendShortcut === "enter" ? !e.shiftKey && !withMod : withMod
    if (shouldSend) {
      e.preventDefault()
      send()
    }
  }

  const visibleMessages = searchQuery.trim()
    ? messages.filter((m) =>
        m.text.toLowerCase().includes(searchQuery.trim().toLowerCase()),
      )
    : messages

  return (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-[#FAFCFB]/90">
      {/* Top-Right Window & Search Bar matching attachment */}
      <header className="h-[46px] px-6 flex items-center justify-end gap-4 shrink-0 select-none">
        {!isEmpty && searchOpen && (
          <div className="flex items-center gap-1.5 bg-[#F2F5F3] border border-[#E3EAE6] rounded-[10px] px-3 py-1 mr-auto sm:mr-2">
            <Search className="w-3.5 h-3.5 text-[#7A8781]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索对话内容..."
              autoFocus
              className="bg-transparent outline-none text-[12.5px] text-[#1F2D27] placeholder:text-[#8F9C96] w-44"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="text-[#8F9C96] hover:text-[#1F2D27] cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}

        {/* Quick preview toggle between First-Run Empty State and Populated Conversation */}
        {isEmpty ? (
          <button
            type="button"
            onClick={onLoadSampleConversation}
            className="h-7 px-2.5 rounded-[8px] bg-[#EEF5F1] hover:bg-[#E1F4E8] text-[#2B5B41] hover:text-[#1FA958] text-[12px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            title="预览已有对话的完整卡片效果"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span>查看对话示例</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false)
              setSearchQuery("")
              onResetToEmpty()
            }}
            className="h-7 px-2.5 rounded-[8px] bg-[#F2F5F3] hover:bg-[#E6EFEA] text-[#586660] hover:text-[#1E2E26] text-[12px] flex items-center gap-1.5 transition-colors cursor-pointer"
            title="切换到刚打开系统、还没开始说话时的空白欢迎界面"
          >
            <RotateCcw className="w-3 h-3" />
            <span>初次使用态</span>
          </button>
        )}

        {!isEmpty && (
          <button
            type="button"
            onClick={() => {
              setSearchOpen((v) => !v)
              if (searchOpen) setSearchQuery("")
            }}
            title="搜索对话"
            aria-label="搜索对话"
            className={`p-1.5 rounded-[8px] transition-colors cursor-pointer ${
              searchOpen
                ? "bg-[#E1F4E8] text-[#1FA958]"
                : "text-[#4A5550] hover:bg-black/[0.04]"
            }`}
          >
            <Search className="w-[17px] h-[17px]" strokeWidth={1.8} />
          </button>
        )}

        <div className="flex items-center gap-3.5 text-[#4A5550]" aria-hidden>
          <Minus className="w-[16px] h-[16px]" strokeWidth={1.7} />
          <Square className="w-[13px] h-[13px]" strokeWidth={1.7} />
          <X className="w-[16px] h-[16px]" strokeWidth={1.7} />
        </div>
      </header>

      {/* Continuous Conversation Canvas (No Session Sidebar) */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {isEmpty ? (
          /* ------------------------------------------------------------------ */
          /* First-Time / Empty Conversation Welcome State                      */
          /* ------------------------------------------------------------------ */
          <div className="min-h-full max-w-[720px] mx-auto px-6 sm:px-10 py-6 flex flex-col items-center justify-center select-none">
            {/* Buddy Hero Greeting */}
            <div className="flex flex-col items-center text-center">
              <div className="relative">
                <div className="absolute -inset-3 rounded-full bg-[#DDF4E6]/65 blur-xl pointer-events-none" />
                <BuddyAvatar size="xl" showSpark className="relative" />
              </div>

              <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#E6F6EC] border border-[#CFEAD9] text-[11.5px] font-medium text-[#1F7A46]">
                <span className="w-1.5 h-1.5 rounded-full bg-[#22B560]" />
                <span>在线 · 随时听你招呼</span>
              </div>

              <h1 className="mt-3 text-[22px] font-bold text-[#18221E] tracking-tight">
                嗨，我是 Buddy
              </h1>
              <p className="mt-1.5 max-w-[440px] text-[13.5px] text-[#66756E] leading-relaxed">
                这里没有复杂的菜单，也不用新建会话。无论是理清思路、起草文案、出出主意，还是规划日常，像跟朋友发消息一样直接说就行。
              </p>
            </div>

            {/* Natural Starter Cards matching the attachment's visual style */}
            <div className="w-full mt-7 space-y-3">
              <div className="text-[12px] font-medium text-[#7B8A83] px-1 flex items-center justify-between">
                <span>你可以点下面任意一句，直接开始跟我聊：</span>
              </div>

              {/* Rich Starter Card 1: Life Aesthetics Note (Mirrors Card 1 of reference: photo + pill) */}
              <button
                type="button"
                onClick={() =>
                  onSend("帮我把今天调研的咖啡馆打卡体验做成一份松弛感小记，提炼几句生活随笔")
                }
                className="w-full text-left bg-white hover:bg-[#FCFDFC] rounded-[16px] border border-[#ECF1EE] hover:border-[#BDE2CC] shadow-[0_6px_22px_rgba(18,38,28,0.038)] hover:shadow-[0_10px_28px_rgba(34,181,96,0.08)] p-3.5 flex flex-col sm:flex-row items-center gap-4 transition-all group cursor-pointer"
              >
                <img
                  src="https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=320&h=220&fit=crop&auto=format"
                  alt="日常灵感预览"
                  className="w-full sm:w-[116px] h-[78px] rounded-[11px] object-cover shrink-0 border border-black/[0.04]"
                />
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-[14px] font-medium text-[#1E2E26] leading-snug">
                    “帮我把今天调研的咖啡馆体验做成一份松弛感小记，提炼几句生活随笔”
                  </p>
                  <div className="flex items-center justify-between">
                    <div className="bg-[#EEF8F2] rounded-[8px] px-2.5 py-1 inline-flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded-full bg-[#22B560] text-white flex items-center justify-center">
                        <Check className="w-2.5 h-2.5" strokeWidth={3} />
                      </span>
                      <span className="text-[11.5px] font-medium text-[#1F7A46]">
                        保留自然光影感，提炼 3 处治愈细节
                      </span>
                    </div>
                    <span className="text-[12px] font-medium text-[#22B560] opacity-75 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all flex items-center gap-1">
                      <span>试一试</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              </button>

              {/* Rich Starter Card 2: Weekend Trail Guide (Mirrors Card 2 of reference: text + illustration) */}
              <button
                type="button"
                onClick={() =>
                  onSend("周末想去近郊徒步放松，帮我规划一条轻量半日路线，带一张清爽手绘路线卡")
                }
                className="w-full text-left bg-white hover:bg-[#FCFDFC] rounded-[16px] border border-[#ECF1EE] hover:border-[#BDE2CC] shadow-[0_6px_22px_rgba(18,38,28,0.038)] hover:shadow-[0_10px_28px_rgba(34,181,96,0.08)] p-3.5 flex flex-col sm:flex-row items-center justify-between gap-4 transition-all group cursor-pointer"
              >
                <div className="flex-1 min-w-0 space-y-2">
                  <p className="text-[14px] font-medium text-[#1E2E26] leading-snug">
                    “周末想去近郊徒步放松，帮我规划一条轻量半日路线，带一张清爽手绘路线卡”
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="text-[12px] text-[#7A8781]">
                      避开拥挤人群，标明绿荫坡道与沿途补给休息点
                    </span>
                    <span className="text-[12px] font-medium text-[#22B560] opacity-75 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all inline-flex items-center gap-1 shrink-0">
                      <span>试一试</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
                <LandscapeIllustration className="w-[116px] h-[74px]" />
              </button>

              {/* Custom Badge Starters Row: Bespoke Styled Icons with Subtle Layered Gradients */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() =>
                    onSend("帮我找几个启发性强的新选题角度，重点看有哪些反常识思考点")
                  }
                  className="text-left bg-white/90 hover:bg-white rounded-[14px] border border-[#ECF1EE] hover:border-[#BDE2CC] shadow-[0_4px_16px_rgba(18,38,28,0.03)] p-3.5 flex items-start gap-3 transition-all group cursor-pointer"
                >
                  <InspirationBadgeIcon />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#1E2E26] leading-snug">
                      “发掘几个启发性强的切入角度”
                    </div>
                    <div className="text-[11.5px] text-[#7A8781] mt-1">
                      提炼引起高共鸣的思考钩子与痛点
                    </div>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onSend("帮我把手头杂乱的想法理顺，整理出一份简洁明了的备忘大纲")
                  }
                  className="text-left bg-white/90 hover:bg-white rounded-[14px] border border-[#ECF1EE] hover:border-[#BDE2CC] shadow-[0_4px_16px_rgba(18,38,28,0.03)] p-3.5 flex items-start gap-3 transition-all group cursor-pointer"
                >
                  <DigestBadgeIcon />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#1E2E26] leading-snug">
                      “把杂乱想法整理为备忘大纲”
                    </div>
                    <div className="text-[11.5px] text-[#7A8781] mt-1">
                      结构化提炼核心要点与下一步行动
                    </div>
                  </div>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* ------------------------------------------------------------------ */
          /* Active Conversation Stream                                         */
          /* ------------------------------------------------------------------ */
          <div className="max-w-[880px] mx-auto px-6 sm:px-10 pt-2 pb-6 space-y-6 select-text">
            {visibleMessages.map((msg) => {
              const mine = msg.from === "me"

              // User Message on Right: Soft Mint Bubble + Portrait Avatar
              if (mine) {
                return (
                  <div key={msg.id} className="flex items-center justify-end gap-3.5">
                    <div
                      className={`max-w-[68%] px-4 py-3 rounded-[15px] rounded-br-[5px] bg-[#E3F3E9] text-[#1E2E26] leading-[1.58] shadow-[0_2px_10px_rgba(34,181,96,0.05)] break-words ${textSize}`}
                    >
                      <Linkified text={msg.text} />
                    </div>
                    <UserAvatar />
                  </div>
                )
              }

              // Buddy Assistant Message on Left: Buddy Avatar + Floating White Card
              return (
                <div key={msg.id} className="flex items-start justify-start gap-3.5">
                  <BuddyAvatar size="md" showSpark className="mt-1" />

                  <div className="relative max-w-[540px] bg-white rounded-[16px] border border-[#EFF3F1] shadow-[0_8px_28px_rgba(18,38,28,0.045)] p-4">
                    {/* Layout 1: Left Photo + Right Text & Green Completion Pill */}
                    {msg.imageLeft ? (
                      <div className="flex flex-col sm:flex-row items-center gap-4">
                        <img
                          src={msg.imageLeft.url}
                          alt={msg.imageLeft.alt}
                          className="w-full sm:w-[192px] h-[126px] rounded-[11px] object-cover shrink-0 border border-black/[0.04]"
                        />
                        <div className="flex-1 min-w-0 space-y-3">
                          <p className={`text-[#2A3832] leading-[1.62] ${textSize}`}>
                            <Linkified text={msg.text} />
                          </p>
                          {msg.statusPill && (
                            <div className="bg-[#EEF8F2] rounded-[10px] px-3 py-2 flex items-center gap-2.5">
                              <span className="w-5 h-5 rounded-full bg-[#22B560] text-white flex items-center justify-center shrink-0">
                                <Check className="w-3 h-3" strokeWidth={3} />
                              </span>
                              <span className="text-[12.5px] font-medium text-[#1F7A46] truncate">
                                {msg.statusPill}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : msg.illustrationRight ? (
                      /* Layout 2: Left Text + Right Landscape Illustration */
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                        <p className={`flex-1 min-w-0 text-[#2A3832] leading-[1.65] ${textSize}`}>
                          <Linkified text={msg.text} />
                        </p>
                        <LandscapeIllustration />
                      </div>
                    ) : (
                      /* Layout 3: Natural Text + Optional Completion Pill */
                      <div className="space-y-2.5">
                        <p className={`text-[#2A3832] leading-[1.62] whitespace-pre-wrap ${textSize}`}>
                          <Linkified text={msg.text} />
                        </p>
                        {msg.statusPill && (
                          <div className="bg-[#EEF8F2] rounded-[10px] px-3 py-1.5 inline-flex items-center gap-2">
                            <span className="w-4 h-4 rounded-full bg-[#22B560] text-white flex items-center justify-center shrink-0">
                              <Check className="w-2.5 h-2.5" strokeWidth={3} />
                            </span>
                            <span className="text-[12px] font-medium text-[#1F7A46]">
                              {msg.statusPill}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            {typing && (
              <div className="flex items-center justify-start gap-3.5 select-none" aria-label="Buddy 正在输入">
                <BuddyAvatar size="md" showSpark />
                <div className="px-4 py-3.5 rounded-[15px] bg-white border border-[#EFF3F1] shadow-[0_6px_20px_rgba(18,38,28,0.04)] flex items-center gap-1.5">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="w-2 h-2 rounded-full bg-[#78C999] animate-bounce"
                      style={{ animationDelay: `${delay}ms`, animationDuration: "1s" }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Composer Bar matching attachment */}
      <div className="shrink-0 px-6 sm:px-10 pb-5 pt-2 select-none relative">
        {/* Active Voice Recording Status Bar overlay above composer */}
        {isRecording && (
          <div className="max-w-[880px] mx-auto mb-2 px-4 py-2 rounded-[12px] bg-[#EAF8F0] border border-[#BCE8CE] shadow-[0_4px_14px_rgba(34,181,96,0.12)] flex items-center justify-between animate-fade-in">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#22B560] opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-[#1FA958]" />
              </span>
              <span className="text-[12.5px] font-medium text-[#1A7742]">
                正在倾听语音... ({recordingSeconds}s)
              </span>
              <span className="text-[11.5px] text-[#639276] hidden sm:inline">
                说完了点右侧绿色按钮直接发送
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCancelVoice}
                className="text-[11.5px] text-[#728A7C] hover:text-[#283830] px-2 py-0.5 rounded cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleToggleVoice}
                className="h-6 px-2.5 rounded-[7px] bg-[#22B560] hover:bg-[#1CA354] text-white text-[11.5px] font-medium flex items-center gap-1 cursor-pointer"
              >
                <span>完成并发送</span>
              </button>
            </div>
          </div>
        )}

        <div className="max-w-[880px] mx-auto h-[52px] px-4 rounded-[15px] bg-[#F3F6F4] border border-[#E6ECE9] flex items-center gap-3 focus-within:bg-white focus-within:border-[#CBE5D6] focus-within:shadow-[0_4px_20px_rgba(34,181,96,0.07)] transition-all">
          <button
            type="button"
            onClick={() => {
              setDraft("帮我把这份会议速记整理成 3 个关键结论和待办安排")
              inputRef.current?.focus()
            }}
            title="添加素材或附件"
            aria-label="添加素材或附件"
            className="text-[#586660] hover:text-[#1FA958] transition-colors cursor-pointer shrink-0"
          >
            <Paperclip className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </button>

          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            placeholder={isEmpty ? "和 Buddy 说第一句话吧..." : "和 Buddy 说点什么..."}
            aria-label="发消息"
            className={`flex-1 min-w-0 bg-transparent outline-none text-[#1E2E26] placeholder:text-[#98A6A0] select-text ${textSize}`}
          />

          <button
            type="button"
            onClick={() => {
              setDraft("给下周的项目沟通起草一份简短明了的要点提纲，语气亲和一点")
              inputRef.current?.focus()
            }}
            title="填入示例话题"
            className="text-[#6C7A74] hover:text-[#1E2E26] transition-colors cursor-pointer shrink-0"
          >
            <ChevronDown className="w-[18px] h-[18px]" strokeWidth={1.8} />
          </button>

          {/* Voice Input Button: Positioned on the immediate left of the Send button as requested */}
          <button
            type="button"
            onClick={handleToggleVoice}
            title={isRecording ? "停止录音并发送" : "语音输入发送"}
            aria-label={isRecording ? "停止录音并发送" : "语音输入发送"}
            className={`w-[34px] h-[34px] rounded-full flex items-center justify-center transition-all cursor-pointer shrink-0 ${
              isRecording
                ? "bg-[#22B560] text-white animate-pulse shadow-[0_2px_10px_rgba(34,181,96,0.4)]"
                : "bg-[#E6ECE8] hover:bg-[#DDE6E0] text-[#3D4D45] hover:text-[#1A2621]"
            }`}
          >
            <Mic className="w-[17px] h-[17px]" strokeWidth={isRecording ? 2.3 : 1.9} />
          </button>

          {/* Send Button */}
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim()}
            aria-label="发送"
            className="w-[34px] h-[34px] rounded-full bg-[#22B560] hover:bg-[#1CA354] text-white flex items-center justify-center shadow-[0_2px_8px_rgba(34,181,96,0.3)] transition-all cursor-pointer disabled:opacity-45 disabled:shadow-none disabled:cursor-default shrink-0"
          >
            <ArrowUp className="w-[17px] h-[17px]" strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </main>
  )
}
