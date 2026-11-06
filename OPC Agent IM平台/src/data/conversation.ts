import {
  BuddyCreation,
  BuddyMemory,
  BuddyTask,
  ChatMessage,
} from "../types/chat"

export const ASSISTANT_NAME = "Buddy"

const today = new Date()
const at = (daysAgo: number, h: number, m: number) => {
  const d = new Date(today)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

export const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "m1",
    from: "me",
    text: "帮我把今天调研的咖啡馆打卡体验做成一份松弛感小记，提炼几句生活随笔",
    at: at(0, 10, 18),
  },
  {
    id: "m2",
    from: "assistant",
    text: "已经帮你整理好了，保留了午后自然光和慢节奏的氛围感，重点提炼了 3 处最值得停留的细节。",
    at: at(0, 10, 19),
    imageLeft: {
      url: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=480&h=320&fit=crop&auto=format",
      alt: "生活灵感随笔封面",
    },
    statusPill: "图文小记已整理好，随时可以查阅",
  },
  {
    id: "m3",
    from: "me",
    text: "写得很自然，周末去近郊徒步的轻量半日路线也顺便帮我理一份吧",
    at: at(0, 10, 21),
  },
  {
    id: "m4",
    from: "assistant",
    text: "规划好了，选了一条坡度缓和的绿荫环线避开了人流，路线卡片做成了清爽手绘风，补给点都标在右边了。",
    at: at(0, 10, 22),
    illustrationRight: true,
  },
]

export const INITIAL_TASKS: BuddyTask[] = [
  {
    id: "t-1",
    title: "整理咖啡馆探店笔记并提炼生活随笔",
    note: "保留自然光影感与 3 处治愈细节，已归档",
    done: true,
    updatedAt: "今天 10:19",
  },
  {
    id: "t-2",
    title: "规划周末近郊轻量徒步路线与补给点",
    note: "手绘风山谷路线卡已生成，标明了绿荫缓坡与休息亭",
    done: true,
    updatedAt: "今天 10:22",
  },
  {
    id: "t-3",
    title: "梳理下周提案的 3 个核心切入角度",
    note: "提炼更能引起共鸣的思考钩子与痛点分析",
    done: false,
    updatedAt: "今天 11:00",
  },
  {
    id: "t-4",
    title: "排布本周工作的轻重缓急与休息节奏",
    note: "预留出不被打扰的思考时间与周末放松安排",
    done: false,
    updatedAt: "待办",
  },
]

export const INITIAL_CREATIONS: BuddyCreation[] = [
  {
    id: "c-1",
    title: "午后窗边的慢调探店小记",
    subtitle: "图文随笔 · 记录生活美学与 3 处治愈细节",
    kind: "video",
    previewUrl:
      "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=560&h=360&fit=crop&auto=format",
    createdAt: "今天 10:19",
    statusText: "随笔已归档",
  },
  {
    id: "c-2",
    title: "周末近郊轻量徒步指南",
    subtitle: "清爽手绘路线卡 · 绿荫缓坡避开人群",
    kind: "cover",
    useIllustration: true,
    createdAt: "今天 10:22",
    statusText: "路线图已生成",
  },
  {
    id: "c-3",
    title: "「让问题变得具体」思维灵感笔记",
    subtitle: "整理自近期讨论的高共鸣思考模型与行动要点",
    kind: "research",
    previewUrl:
      "https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=560&h=360&fit=crop&auto=format",
    createdAt: "昨天 21:45",
    statusText: "笔记已归档",
  },
]

export const INITIAL_MEMORIES: BuddyMemory[] = [
  {
    id: "mem-1",
    category: "文字风格",
    content: "文案喜欢松弛自然的生活感，不堆砌辞藻，语气像跟朋友聊天。",
    active: true,
    updatedAt: "今天更新",
  },
  {
    id: "mem-2",
    category: "视觉偏好",
    content: "视觉喜欢清爽通透的薄荷绿与浅蓝配色，画面干净，适当留白。",
    active: true,
    updatedAt: "今天更新",
  },
  {
    id: "mem-3",
    category: "工作习惯",
    content: "做计划和建议时，优先挑执行难度低、性价比高、能立刻落地的方案。",
    active: true,
    updatedAt: "昨天记录",
  },
  {
    id: "mem-4",
    category: "沟通习惯",
    content: "直接给清晰的结论和做好的成品，不需要罗列繁琐的后台过程说明。",
    active: true,
    updatedAt: "长期偏好",
  },
]
