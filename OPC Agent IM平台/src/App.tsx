import React, { useState } from 'react';
import {
  CANDIDATE_AGENTS,
  INITIAL_AGENTS,
  INITIAL_CONVERSATIONS,
  INITIAL_DEPARTMENTS,
} from './data/initialData';
import {
  AgentEmployee,
  CandidateAgent,
  ChatMessage,
  Conversation,
  Department,
  NavTab,
} from './types/im';
import { TopTitleBar } from './components/TopTitleBar';
import { LeftNavRail } from './components/LeftNavRail';
import { SessionList } from './components/SessionList';
import { ChatWorkspace } from './components/ChatWorkspace';
import { HrOrgView } from './components/HrOrgView';
import { SettingsView } from './components/settings/SettingsView';
import { Onboarding } from './components/onboarding/Onboarding';
import { useOnboarding } from './components/onboarding/onboardingStore';
import { AvatarIcon } from './components/AvatarIcon';
import { Users } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>('im');
  const onboarding = useOnboarding();
  const [departments, setDepartments] = useState<Department[]>(INITIAL_DEPARTMENTS);
  const [agents, setAgents] = useState<AgentEmployee[]>(INITIAL_AGENTS);
  const [candidates] = useState<CandidateAgent[]>(CANDIDATE_AGENTS);
  const [conversations, setConversations] = useState<Conversation[]>(INITIAL_CONVERSATIONS);
  // Default selected conversation is "conv-shanglei" ("殇丶泪") to match the screenshot 1:1
  const [activeConvId, setActiveConvId] = useState<string>('conv-shanglei');
  const [rightDrawerOpen, setRightDrawerOpen] = useState<boolean>(false);
  const [typingByConv, setTypingByConv] = useState<Record<string, string[]>>({});
  const [showCreateGroupModal, setShowCreateGroupModal] = useState<boolean>(false);
  const [newGroupName, setNewGroupName] = useState<string>('');
  const [selectedGroupAgentIds, setSelectedGroupAgentIds] = useState<string[]>([
    'agent-shanglei',
    'agent-wool',
    'agent-shark',
  ]);

  const activeConversation =
    conversations.find((c) => c.id === activeConvId) || conversations[0];

  const getNowTime = () => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  };

  // Helper to append a message to a conversation and update its sidebar preview
  const appendMessage = (
    convId: string,
    msg: ChatMessage,
    prefixHighlight?: string
  ) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const previewText =
          msg.type === 'deliverable-card' && msg.deliverable
            ? msg.deliverable.title
            : msg.senderId === 'user'
            ? msg.text || ''
            : `${msg.senderName}: ${msg.text || ''}`;

        return {
          ...c,
          lastMessage: previewText,
          lastMessagePrefixHighlight: prefixHighlight,
          timestamp: msg.timestamp,
          unreadCount: c.id === activeConvId ? 0 : (c.unreadCount || 0) + 1,
          unreadDisplay:
            c.id === activeConvId ? undefined : String((c.unreadCount || 0) + 1),
          messages: [...c.messages, msg],
        };
      })
    );
  };

  // Send message from User (Boss) and trigger realistic 1v1 or Multi-Agent group replies
  const handleSendMessage = (convId: string, text: string) => {
    const timeStr = getNowTime();
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      senderId: 'user',
      senderName: '丶殇泪',
      senderAvatarType: 'founder-girl',
      timestamp: timeStr,
      type: 'text',
      text,
    };

    appendMessage(convId, userMsg);

    const targetConv = conversations.find((c) => c.id === convId);
    if (!targetConv) return;

    const convAgents = agents.filter((a) => targetConv.memberAgentIds.includes(a.id));
    if (convAgents.length === 0) return;

    // Check if a specific Agent was @mentioned
    const mentionedAgents = convAgents.filter((a) => text.includes(`@${a.name}`));
    const responders =
      mentionedAgents.length > 0
        ? mentionedAgents
        : targetConv.type === 'group'
        ? convAgents.slice(0, Math.min(2, convAgents.length))
        : [convAgents[0]];

    setTypingByConv((prev) => ({
      ...prev,
      [convId]: responders.map((r) => r.name),
    }));

    // First Agent reply
    setTimeout(() => {
      const firstAgent = responders[0];
      const nextAgent = responders[1] || convAgents.find((a) => a.id !== firstAgent.id);

      let replyText = '';
      if (text.includes('抖音') || text.includes('3') || text.includes('关键词') || text.includes('爆款')) {
        replyText = nextAgent
          ? `收到老板指令！我已通过抖音爬虫抓取目标关键词下近7天 TOP 200 视频，按「点赞/收藏/评论 ≥ 原博主历史均值 3.0 倍」过滤出 4 条异常高爆样本（最高一条达 4.8 倍均值，核心钩子为「AI反向追问代替直接给答案」）。@${nextAgent.name} 请立刻接手拆解前3秒分镜并按 brief.md 合成成片！`
          : `收到！已执行「搜抖音关键词 + 筛选点赞/收藏/评论超原博主均值 3 倍以上」策略：\n1. 命中样本A：《AI反向操作才是王炸》— 收藏率达博主均值 4.6 倍\n2. 命中样本B：《一人公司不要基础岗》— 完播率 42.8%，评论超均值 3.3 倍\n我已按 brief.md 规范（vignette=PI/16，色温 [4800, 7200]，自适应闭环 gamma ≤ 4）启动 23 镜头纯影像成片合成！`;
      } else if (text.includes('成片') || text.includes('vignette') || text.includes('短剧')) {
        replyText = `明白！已严格按照 brief.md 规范锁定参数：1080×1920 / 30fps / h264 2.43Mbps + aac，vignette=PI/16，色温夹在 [4800, 7200]，字幕 55/55 句对比度实测 19.8:1，音频响度 mean -17.0 dB / max -0.6 dB。成片压制完成后自动投递「抖音精选App知识充电站」。`;
      } else {
        replyText = nextAgent
          ? `收到老板指示：「${text.slice(0, 38)}」。我已完成本节点拆解并更新至部门 brief.md 记忆库，现将下游产出移交 @${nextAgent.name} 继续协同执行！`
          : `收到老板指令！我已调取部门 brief.md 规范并启动沙盒执行，预计 40 秒内输出结构化交付物。`;
      }

      const firstReply: ChatMessage = {
        id: `msg-${Date.now()}-a1`,
        senderId: firstAgent.id,
        senderName: firstAgent.name,
        senderRole: `${firstAgent.role} · ${firstAgent.level}`,
        senderAvatarType: firstAgent.avatarType,
        senderAvatarUrl: firstAgent.avatarUrl,
        timestamp: getNowTime(),
        type: 'text',
        text: replyText,
      };

      appendMessage(convId, firstReply);

      // If group chat or multi-agent, trigger second Agent handoff reply
      if (targetConv.type === 'group' && nextAgent) {
        setTypingByConv((prev) => ({
          ...prev,
          [convId]: [nextAgent.name],
        }));

        setTimeout(() => {
          const secondReply: ChatMessage = {
            id: `msg-${Date.now()}-a2`,
            senderId: nextAgent.id,
            senderName: nextAgent.name,
            senderRole: `${nextAgent.role} · ${nextAgent.level}`,
            senderAvatarType: nextAgent.avatarType,
            senderAvatarUrl: nextAgent.avatarUrl,
            timestamp: getNowTime(),
            type: 'text',
            text: `@${firstAgent.name} 已接棒！我这边已拿到你筛出的 3 倍均值爆款结构，0.3 倍率通道已完成初筛，23 个纯影像镜头切点已 100% 对齐字幕段落边界，随时可请 @丶殇泪 验收！`,
          };
          appendMessage(convId, secondReply);
          setTypingByConv((prev) => ({ ...prev, [convId]: [] }));
        }, 1200);
      } else {
        setTypingByConv((prev) => ({ ...prev, [convId]: [] }));
      }
    }, 950);
  };

  // Trigger autonomous Agent-to-Agent collaboration in the active chat
  const handleTriggerAgentCollab = (convId: string) => {
    const targetConv = conversations.find((c) => c.id === convId);
    if (!targetConv) return;

    const memberList = agents.filter((a) => targetConv.memberAgentIds.includes(a.id));
    const a1 = memberList[0] || agents[0];
    const a2 = memberList[1] || agents.find((a) => a.id !== a1.id) || a1;

    setTypingByConv((prev) => ({
      ...prev,
      [convId]: [a1.name, a2.name],
    }));

    setTimeout(() => {
      const msg1: ChatMessage = {
        id: `collab-${Date.now()}-1`,
        senderId: a1.id,
        senderName: a1.name,
        senderRole: `${a1.role} · ${a1.level}`,
        senderAvatarType: a1.avatarType,
        senderAvatarUrl: a1.avatarUrl,
        timestamp: getNowTime(),
        type: 'text',
        text: `@${a2.name} 我刚跑完抖音「AI反向操作」关键词爬虫，筛出 3 条点赞/收藏超原博主均值 3.5 倍以上的爆款视频，痛点集中在「一人公司如何用 Agent 替代基础剪辑岗」，口播初稿已同步到共享沙盒。`,
      };
      appendMessage(convId, msg1);

      setTimeout(() => {
        const msg2: ChatMessage = {
          id: `collab-${Date.now()}-2`,
          senderId: a2.id,
          senderName: a2.name,
          senderRole: `${a2.role} · ${a2.level}`,
          senderAvatarType: a2.avatarType,
          senderAvatarUrl: a2.avatarUrl,
          timestamp: getNowTime(),
          type: 'deliverable-card',
          deliverable: {
            introText: `已接收 @${a1.name} 的3倍爆款脚本，自动合成并完成质检交付：`,
            title: '交付：AI反向操作才是王炸（3倍爆款跟进版）',
            workId: '7700192837465019283',
            accountName: '长话短说',
            status: 'published',
            campaigns: '抖音精选App知识充电站 + 抖音精选App征稿中',
            link: 'https://www.douyin.com/video/7700192837465019283',
            specsTitle: '成片',
            specs: [
              '1080×1920 / 30fps / 128.40s / 41.2MB / h264 2.43Mbps + aac',
              '23 个镜头全程纯影像，无文字板；切点严格落在字幕段落边界上',
              '字幕对比度 ≥ 3:1（实测 19.8:1），黑帧 0，解码无错',
              '音频 mean -17.0 dB / max -0.6 dB',
            ],
            pitfallsTitle: '已自动应用 brief.md 防坑参数',
            pitfalls: [
              '已锁定 vignette=PI/16，规避 9:16 竖屏边缘 55% 亮度塌陷。',
              '色温执行「只收暖不硬拉冷」，严格夹在 [4800, 7200] 区间。',
              "每镜自适应闭环 gamma：按 y' = y·ln(lum_obs/255)/ln(goal/255) 单轮收敛，实测误差 ≤ 3。",
            ],
            footerPlaceholder: '发消息... (Enter 发送，Shift+Enter 换行，可拖入/粘贴素材)',
          },
        };
        appendMessage(convId, msg2);
        setTypingByConv((prev) => ({ ...prev, [convId]: [] }));
      }, 1100);
    }, 700);
  };

  // Pull an existing Agent employee into a conversation
  const handlePullAgentToChat = (convId: string, agentId: string) => {
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        if (c.memberAgentIds.includes(agentId)) return c;
        const sysMsg: ChatMessage = {
          id: `sys-${Date.now()}`,
          senderId: 'system',
          senderName: 'HR系统',
          timestamp: getNowTime(),
          type: 'system',
          text: `老板已将「${ag.name} (${ag.role})」拉入当前会话参与跨部门协同`,
        };
        const greetMsg: ChatMessage = {
          id: `greet-${Date.now()}`,
          senderId: ag.id,
          senderName: ag.name,
          senderRole: `${ag.role} · ${ag.level}`,
          senderAvatarType: ag.avatarType,
          senderAvatarUrl: ag.avatarUrl,
          timestamp: getNowTime(),
          type: 'text',
          text: `老板好！我是 ${ag.name}，已挂载本群上下文与 brief.md 规范，随时可以配合团队协同执行任务！`,
        };
        return {
          ...c,
          type: 'group',
          memberAgentIds: [...c.memberAgentIds, agentId],
          lastMessage: `${ag.name}: 已挂载本群上下文与 brief.md 规范`,
          timestamp: getNowTime(),
          messages: [...c.messages, sysMsg, greetMsg],
        };
      })
    );
  };

  // Hire a candidate Agent from the Talent Market into a Department
  const handleHireCandidate = (cand: CandidateAgent, targetDeptId: string) => {
    // Candidate ID keeps IDs unique when several candidates are hired in the same tick.
    const hireKey = `${Date.now()}-${cand.id}`;
    const newAgentId = `agent-hired-${hireKey}`;
    const newAgent: AgentEmployee = {
      id: newAgentId,
      name: cand.name,
      role: cand.role,
      level: cand.level,
      departmentId: targetDeptId,
      avatarType: 'custom',
      avatarUrl: cand.avatarUrl,
      model: cand.model,
      status: 'working',
      skills: cand.skills,
      systemPrompt: cand.systemPrompt,
      briefMd: cand.briefMd,
      tokenCostPerDay: cand.tokenCostPerDay,
      completedTasks: 1,
      hiredAt: '刚刚入职',
    };

    setAgents((prev) => [newAgent, ...prev]);

    const dept = departments.find((d) => d.id === targetDeptId);
    const nowTime = getNowTime();
    const newDmId = `conv-dm-${hireKey}`;

    const newDmConv: Conversation = {
      id: newDmId,
      title: newAgent.name,
      type: 'dm',
      avatarType: 'custom',
      avatarUrl: newAgent.avatarUrl,
      lastMessage: `老板好！我已入职「${dept?.name || 'OPC部门'}」并加载 brief.md`,
      timestamp: nowTime,
      departmentId: targetDeptId,
      primaryAgentId: newAgentId,
      memberAgentIds: [newAgentId],
      messages: [
        {
          id: `sys-hire-${hireKey}`,
          senderId: 'system',
          senderName: 'HR系统',
          timestamp: nowTime,
          type: 'system',
          text: `[HR组织架构通知] 您已成功聘用「${newAgent.name} (${newAgent.level})」加入「${dept?.name || ''}」`,
        },
        {
          id: `msg-hire-${hireKey}`,
          senderId: newAgentId,
          senderName: newAgent.name,
          senderRole: `${newAgent.role} · ${newAgent.level}`,
          senderAvatarType: 'custom',
          senderAvatarUrl: newAgent.avatarUrl,
          timestamp: nowTime,
          type: 'text',
          text: `老板好！我是新入职的「${newAgent.name}」（岗位：${newAgent.role}）。我已自动读取公司的 brief.md 踩坑规范，并加入了「${dept?.name || '部门'}」工作群，请直接给我派发第一单任务！`,
        },
      ],
    };

    // Add DM at top of IM list & also add Agent to the department's group chat
    setConversations((prev) => {
      const updated = prev.map((c) => {
        if (dept && c.id === dept.groupConversationId) {
          return {
            ...c,
            memberAgentIds: [...c.memberAgentIds, newAgentId],
            lastMessage: `[HR通知] 新员工 @${newAgent.name} 已入职本部门群`,
            timestamp: nowTime,
            messages: [
              ...c.messages,
              {
                id: `grp-join-${hireKey}`,
                senderId: newAgentId,
                senderName: newAgent.name,
                senderRole: `${newAgent.role} · ${newAgent.level}`,
                senderAvatarType: 'custom' as const,
                senderAvatarUrl: newAgent.avatarUrl,
                timestamp: nowTime,
                type: 'text' as const,
                text: `大家好！我是新入职「${dept.name}」的 ${newAgent.name}，接下来和大家一起在群里协同冲刺爆款！`,
              },
            ],
          };
        }
        return c;
      });
      return [newDmConv, ...updated];
    });

    setActiveConvId(newDmId);
    setActiveTab('im');
  };

  // Custom create an Agent employee
  const handleCreateCustomAgent = (
    name: string,
    role: string,
    level: string,
    deptId: string,
    model: string,
    skills: string[],
    briefMd: string
  ) => {
    const customCand: CandidateAgent = {
      id: `cand-custom-${Date.now()}`,
      name,
      role,
      level,
      recommendedDeptId: deptId,
      avatarUrl:
        'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=120&h=120&fit=crop&auto=format',
      model,
      skills,
      bio: `OPC定制专岗Agent · ${role}`,
      systemPrompt: `你是${name}，担任${role}。`,
      briefMd,
      tokenCostPerDay: '¥8.0 / 天',
      highlightMetric: '定制专岗 Agent',
    };
    handleHireCandidate(customCand, deptId);
  };

  // Start or jump to 1v1 DM with an existing Agent from the HR Org Chart
  const handleStartDmWithAgent = (agentId: string) => {
    const ag = agents.find((a) => a.id === agentId);
    if (!ag) return;

    const existing = conversations.find(
      (c) => c.type === 'dm' && (c.primaryAgentId === agentId || c.title === ag.name)
    );
    if (existing) {
      setActiveConvId(existing.id);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === existing.id ? { ...c, unreadCount: 0, unreadDisplay: undefined } : c
        )
      );
      setActiveTab('im');
      return;
    }

    const nowTime = getNowTime();
    const newConvId = `conv-dm-${agentId}`;
    const newConv: Conversation = {
      id: newConvId,
      title: ag.name,
      type: 'dm',
      avatarType: ag.avatarType,
      avatarUrl: ag.avatarUrl,
      lastMessage: `${ag.name}: 随时待命，请指示！`,
      timestamp: nowTime,
      departmentId: ag.departmentId,
      primaryAgentId: ag.id,
      memberAgentIds: [ag.id],
      messages: [
        {
          id: `dm-init-${Date.now()}`,
          senderId: ag.id,
          senderName: ag.name,
          senderRole: `${ag.role} · ${ag.level}`,
          senderAvatarType: ag.avatarType,
          senderAvatarUrl: ag.avatarUrl,
          timestamp: nowTime,
          type: 'text',
          text: `老板好！我是「${ag.name}」（${ag.role}），当前状态：在线待命。我已挂载本部门最新 brief.md 规范，请问有什么专项任务需要我立即执行？`,
        },
      ],
    };

    setConversations((prev) => [newConv, ...prev]);
    setActiveConvId(newConvId);
    setActiveTab('im');
  };

  // Open a Department's Group Chat
  const handleOpenDeptGroup = (deptId: string) => {
    const dept = departments.find((d) => d.id === deptId);
    if (!dept) return;
    const grp = conversations.find((c) => c.id === dept.groupConversationId);
    if (grp) {
      setActiveConvId(grp.id);
      setActiveTab('im');
    }
  };

  // Transfer an Agent to another Department
  const handleTransferAgentDept = (agentId: string, newDeptId: string) => {
    setAgents((prev) =>
      prev.map((a) => (a.id === agentId ? { ...a, departmentId: newDeptId } : a))
    );
  };

  // Dismiss an Agent
  const handleDismissAgent = (agentId: string) => {
    setAgents((prev) => prev.filter((a) => a.id !== agentId));
  };

  // Create a new Department + its Department Group Chat
  const handleCreateDepartment = (name: string, code: string, description: string) => {
    const newDeptId = `dept-${Date.now()}`;
    const newGrpId = `conv-grp-${Date.now()}`;
    const leadId = agents[0]?.id || 'agent-shanglei';

    const newDept: Department = {
      id: newDeptId,
      name,
      code,
      leadAgentId: leadId,
      description,
      groupConversationId: newGrpId,
      color: '#0099FF',
    };

    const newGroupConv: Conversation = {
      id: newGrpId,
      title: `${name}工作群`,
      type: 'group',
      avatarType: 'avalonia',
      lastMessage: `[HR通知] 部门「${name}」已成立`,
      timestamp: getNowTime(),
      departmentId: newDeptId,
      memberAgentIds: [leadId, 'agent-hrbp'],
      messages: [
        {
          id: `dept-init-${Date.now()}`,
          senderId: 'system',
          senderName: 'HR系统',
          timestamp: getNowTime(),
          type: 'system',
          text: `新部门「${name} (${code})」已正式组建，您可以在 HR 组织架构中为该部门聘用或调配 Agent 员工。`,
        },
      ],
    };

    setDepartments((prev) => [...prev, newDept]);
    setConversations((prev) => [newGroupConv, ...prev]);
  };

  // Create a custom Multi-Agent Group Chat from the IM "+" button
  const handleCreateMultiAgentGroup = () => {
    if (!newGroupName.trim() || selectedGroupAgentIds.length === 0) return;
    const grpId = `conv-custom-grp-${Date.now()}`;
    const nowTime = getNowTime();
    const chosenAgents = agents.filter((a) => selectedGroupAgentIds.includes(a.id));

    const newConv: Conversation = {
      id: grpId,
      title: newGroupName.trim(),
      type: 'group',
      avatarType: chosenAgents[0]?.avatarType || 'avalonia',
      avatarUrl: chosenAgents[0]?.avatarUrl,
      lastMessage: `${chosenAgents[0]?.name || 'Agent'}: 专项群已集结完毕！`,
      timestamp: nowTime,
      departmentId: chosenAgents[0]?.departmentId,
      memberAgentIds: selectedGroupAgentIds,
      messages: [
        {
          id: `cgrp-sys-${Date.now()}`,
          senderId: 'system',
          senderName: 'HR系统',
          timestamp: nowTime,
          type: 'system',
          text: `已抽调 ${chosenAgents.map((a) => a.name).join('、')} 组建跨部门专项群「${newGroupName.trim()}」`,
        },
        {
          id: `cgrp-m1-${Date.now()}`,
          senderId: chosenAgents[0].id,
          senderName: chosenAgents[0].name,
          senderRole: `${chosenAgents[0].role} · ${chosenAgents[0].level}`,
          senderAvatarType: chosenAgents[0].avatarType,
          senderAvatarUrl: chosenAgents[0].avatarUrl,
          timestamp: nowTime,
          type: 'text',
          text: `老板好！我们 ${chosenAgents.length} 名 Agent 员工已在「${newGroupName.trim()}」集结完毕，共享沙盒与 brief.md 已打通，随时可派发多Agent流水线任务！`,
        },
      ],
    };

    setConversations((prev) => [newConv, ...prev]);
    setActiveConvId(grpId);
    setShowCreateGroupModal(false);
    setNewGroupName('');
    setActiveTab('im');
  };

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-[#EBEBEC]">
      {/* 1:1 macOS Top Window Title Bar */}
      <TopTitleBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onOpenHireModal={() => setActiveTab('market')}
        agentCount={agents.length}
        departmentCount={departments.length}
        rightDrawerOpen={rightDrawerOpen}
        onToggleRightDrawer={() => setRightDrawerOpen((v) => !v)}
      />

      {/* Main Window Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 1:1 Left Navigation Rail */}
        <LeftNavRail
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onQuickJumpConversation={(convId) => {
            setActiveConvId(convId);
            setConversations((prev) =>
              prev.map((c) =>
                c.id === convId ? { ...c, unreadCount: 0, unreadDisplay: undefined } : c
              )
            );
          }}
          unreadTotal={171}
          candidateCount={candidates.length}
        />

        {/* Workspace Content: Settings, HR Org Chart / Talent Marketplace, or the 1:1 IM Platform */}
        {activeTab === 'settings' ? (
          <SettingsView />
        ) : activeTab === 'org' || activeTab === 'market' ? (
          <HrOrgView
            mode={activeTab === 'market' ? 'market' : 'org'}
            onChangeMode={(m) => setActiveTab(m)}
            departments={departments}
            agents={agents}
            candidates={candidates}
            onStartDmWithAgent={handleStartDmWithAgent}
            onOpenDeptGroup={handleOpenDeptGroup}
            onTransferAgentDept={handleTransferAgentDept}
            onDismissAgent={handleDismissAgent}
            onHireCandidate={handleHireCandidate}
            onCreateCustomAgent={handleCreateCustomAgent}
            onCreateDepartment={handleCreateDepartment}
          />
        ) : (
          <>
            {/* 1:1 Conversation Session List */}
            <SessionList
              conversations={conversations}
              activeConversationId={activeConvId}
              onSelectConversation={(id) => {
                setActiveConvId(id);
                setConversations((prev) =>
                  prev.map((c) =>
                    c.id === id ? { ...c, unreadCount: 0, unreadDisplay: undefined } : c
                  )
                );
              }}
              onOpenHireModal={() => setActiveTab('market')}
              onOpenCreateGroupModal={() => setShowCreateGroupModal(true)}
              onSwitchToOrg={() => setActiveTab('org')}
            />

            {/* 1:1 Active Chat Workspace */}
            <ChatWorkspace
              conversation={activeConversation}
              agents={agents}
              departments={departments}
              onSendMessage={handleSendMessage}
              onTriggerAgentCollab={handleTriggerAgentCollab}
              onPullAgentToChat={handlePullAgentToChat}
              onOpenHireModal={() => setActiveTab('market')}
              onUpdateAgentBrief={(agentId, newBrief) => {
                setAgents((prev) =>
                  prev.map((a) => (a.id === agentId ? { ...a, briefMd: newBrief } : a))
                );
              }}
              rightDrawerOpen={rightDrawerOpen}
              onToggleRightDrawer={() => setRightDrawerOpen((v) => !v)}
              typingAgents={typingByConv[activeConversation.id] || []}
            />
          </>
        )}
      </div>

      {/* Modal: Create Multi-Agent Group Chat */}
      {showCreateGroupModal && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 select-none">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl border border-[#E5E5E7] overflow-hidden">
            <div className="px-5 py-4 border-b border-[#EFEFF1] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-[#0099FF]" />
                <h3 className="text-[15px] font-bold text-[#1C1C1E]">
                  组建跨部门多 Agent 协同项目群
                </h3>
              </div>
              <button
                onClick={() => setShowCreateGroupModal(false)}
                className="text-[12.5px] text-[#8E8E93] hover:text-[#1C1C1E] cursor-pointer"
              >
                关闭
              </button>
            </div>

            <div className="p-5 space-y-4 text-[13px]">
              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1">
                  项目群名称
                </label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder="如：抖音3倍爆款短剧冲刺群"
                  className="w-full px-3 py-1.5 rounded-lg border border-[#DCDCE0] focus:border-[#0099FF] outline-none"
                />
              </div>

              <div>
                <label className="block text-[11.5px] font-medium text-[#555558] mb-1.5">
                  勾选拉入群组的 Agent 员工 ({selectedGroupAgentIds.length}名已选)
                </label>
                <div className="max-h-56 overflow-y-auto space-y-1.5 border border-[#EFEFF1] rounded-xl p-2 bg-[#FAFAFC]">
                  {agents.map((ag) => {
                    const checked = selectedGroupAgentIds.includes(ag.id);
                    return (
                      <label
                        key={ag.id}
                        className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                          checked ? 'bg-[#E8F3FF]/70' : 'hover:bg-black/[0.03]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setSelectedGroupAgentIds((prev) =>
                              checked ? prev.filter((id) => id !== ag.id) : [...prev, ag.id]
                            )
                          }
                          className="rounded text-[#0099FF]"
                        />
                        <AvatarIcon
                          type={ag.avatarType}
                          avatarUrl={ag.avatarUrl}
                          name={ag.name}
                          size="xs"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12.5px] font-medium text-[#1C1C1E] truncate">
                            {ag.name}
                          </div>
                          <div className="text-[11px] text-[#8E8E93] truncate">{ag.role}</div>
                        </div>
                        <span className="text-[10.5px] font-mono text-[#0066CC] bg-white px-1.5 py-0.5 rounded border border-[#E5E5E7]">
                          {ag.level}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="px-5 py-3.5 bg-[#F8F8FA] border-t border-[#EFEFF1] flex justify-end gap-2">
              <button
                onClick={() => setShowCreateGroupModal(false)}
                className="px-4 py-1.5 rounded-lg text-[12.5px] text-[#6E6E73] cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={handleCreateMultiAgentGroup}
                className="px-4 py-1.5 rounded-lg bg-[#0099FF] hover:bg-[#0082D9] text-white text-[12.5px] font-medium cursor-pointer"
              >
                立即建群并开启协同
              </button>
            </div>
          </div>
        </div>
      )}

      {onboarding.open && (
        <Onboarding
          agents={agents}
          departments={departments}
          candidates={candidates}
          onHire={handleHireCandidate}
          onNavigate={setActiveTab}
        />
      )}
    </div>
  );
}
