/**
 * Local stand-in for the assistant until a real model backend is connected.
 * Returns the reply as one or more IM-style messages, plus an optional
 * follow-up that arrives later (e.g. "it's done").
 */
import { ChatMessage } from "../types/chat"

export type ReplyItem = Omit<ChatMessage, "id" | "from" | "at">

export interface AssistantReply {
  messages: ReplyItem[]
  followUp?: { delayMs: number; messages: ReplyItem[] }
}

const has = (text: string, words: string[]) => words.some((w) => text.includes(w))

export const replyTo = (raw: string): AssistantReply => {
  const text = raw.trim()

  if (/https?:\/\//.test(text)) {
    return {
      messages: [
        {
          text: "刚帮你看完了链接里的内容，观点很有启发，我把核心亮点和可以复用的框架整理出来了。",
          statusPill: "已解析链接内容",
        },
      ],
    }
  }

  if (has(text, ["徒步", "路线", "出行", "周末", "攻略", "地图"])) {
    return {
      messages: [
        {
          text: "已经帮你把近郊徒步路线整理好了，选了林荫缓坡避开人群，右侧小卡片标明了休息点和预计耗时。",
          illustrationRight: true,
        },
      ],
    }
  }

  if (has(text, ["咖啡", "随笔", "探店", "日常", "生活", "日记"])) {
    return {
      messages: [
        {
          text: "已经帮你整理成一份生活小记，文字自然松弛，挑选了最具光影感的一处角落。",
          imageLeft: {
            url: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=480&h=320&fit=crop&auto=format",
            alt: "生活随笔预览",
          },
          statusPill: "随笔小记已整理好",
        },
      ],
    }
  }

  if (has(text, ["谢", "辛苦", "棒", "不错", "可以了"])) {
    return { messages: [{ text: "不客气，有事随时叫我。" }] }
  }

  if (has(text, ["你好", "在吗", "早", "晚上好", "hi", "Hi", "hello"])) {
    return { messages: [{ text: "在的，今天想让我帮你弄点什么？" }] }
  }

  if (has(text, ["梳理", "总结", "大纲", "备忘", "待办", "计划", "方案", "提纲"])) {
    return {
      messages: [
        {
          text: "好，我来帮你理清楚：\n\n1. 核心目标：先把最重要的第一步定下来，避免事项堆积产生压力\n2. 关键节点：按时间顺序列出 3 个必做动作\n3. 备忘备注：不紧急的事情放进延后观察池\n\n要我把这份清单直接记进你的待办事项里吗？",
          statusPill: "大纲与行动点已理清",
        },
      ],
    }
  }

  if (has(text, ["找", "搜", "灵感", "点子", "角度", "想法", "选题"])) {
    return {
      messages: [
        {
          text: "为你挑出两个很有新意、而且容易引发共鸣的角度：\n\n1. 从「普通人的痛点细节」切入，少谈宏大道理，多讲真实感受\n2. 采用「反常识启发法」，先指出普遍误区，再给出轻量做法\n\n你可以挑一个喜欢的，我帮你顺着展开。",
          statusPill: "已提炼 2 个核心灵感切角",
        },
      ],
    }
  }

  return {
    messages: [
      {
        text: "收到，交给我。已经帮你梳理妥当，需要微调的地方随时告诉我。",
        statusPill: "已处理妥当",
      },
    ],
  }
}
