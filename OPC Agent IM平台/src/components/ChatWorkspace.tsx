import React, { useEffect, useRef, useState } from 'react';
import {
  AtSign,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileText,
  Folder,
  Image as ImageIcon,
  Mic,
  Monitor,
  MonitorSmartphone,
  MoreHorizontal,
  Phone,
  PlusCircle,
  Scissors,
  Send,
  Smile,
  Sparkles,
  UserPlus,
  Video,
  Zap,
} from 'lucide-react';
import { AgentEmployee, ChatMessage, Conversation, Department } from '../types/im';
import { AvatarIcon } from './AvatarIcon';

interface ChatWorkspaceProps {
  conversation: Conversation;
  agents: AgentEmployee[];
  departments: Department[];
  onSendMessage: (convId: string, text: string, mentionIds?: string[]) => void;
  onTriggerAgentCollab: (convId: string) => void;
  onPullAgentToChat: (convId: string, agentId: string) => void;
  onOpenHireModal: () => void;
  onUpdateAgentBrief: (agentId: string, newBrief: string) => void;
  rightDrawerOpen: boolean;
  onToggleRightDrawer: () => void;
  typingAgents: string[];
}

const QUICK_PROMPTS = [
  '按刚才那条3倍均值爆款结构，立刻写一版口播稿并交给 @殇丶泪 合成成片',
  '@情报局小助手 搜抖音关键词「一人公司Agent」，筛出点赞超均值3倍的视频发群里',
  '@全体成员 汇报各自部门今日成片交付进度与 brief.md 更新情况',
  '把 vignette 改成 PI/16，色温夹在 [4800, 7200] 重新压制一版 1080×1920 成片',
];

export const ChatWorkspace: React.FC<ChatWorkspaceProps> = ({
  conversation,
  agents,
  departments,
  onSendMessage,
  onTriggerAgentCollab,
  onPullAgentToChat,
  onOpenHireModal,
  onUpdateAgentBrief,
  rightDrawerOpen,
  onToggleRightDrawer,
  typingAgents,
}) => {
  const [inputText, setInputText] = useState('');
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [showQuickPrompts, setShowQuickPrompts] = useState(false);
  const [showAddMemberMenu, setShowAddMemberMenu] = useState(false);
  const [editingBriefAgentId, setEditingBriefAgentId] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState('');
  const [actionToast, setActionToast] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation.id, conversation.messages.length, typingAgents.length]);

  const triggerToast = (msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 2600);
  };

  const memberAgents = agents.filter((a) => conversation.memberAgentIds.includes(a.id));
  const nonMemberAgents = agents.filter((a) => !conversation.memberAgentIds.includes(a.id));
  const primaryAgent =
    agents.find((a) => a.id === conversation.primaryAgentId) || memberAgents[0];
  const dept = departments.find((d) => d.id === conversation.departmentId);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!inputText.trim()) return;
      onSendMessage(conversation.id, inputText.trim());
      setInputText('');
      setShowMentionPopup(false);
    } else if (e.key === '@') {
      setShowMentionPopup(true);
    }
  };

  const handleInsertMention = (agentName: string) => {
    const next = inputText.endsWith('@')
      ? `${inputText}${agentName} `
      : `${inputText}@${agentName} `;
    setInputText(next);
    setShowMentionPopup(false);
    textareaRef.current?.focus();
  };

  const renderMessageTextWithLinks = (msg: ChatMessage) => {
    const text = msg.text || '';
    if (msg.highlightLink && text.includes(msg.highlightLink)) {
      const parts = text.split(msg.highlightLink);
      return (
        <>
          {parts[0]}
          <a
            href={msg.highlightLink}
            target="_blank"
            rel="noreferrer"
            className="text-[#0066CC] underline break-all hover:text-[#004999]"
          >
            {msg.highlightLink}
          </a>
          {parts[1]}
        </>
      );
    }

    // Highlight @mentions
    const tokens = text.split(/(@[\u4e00-\u9fa5a-zA-Z0-9_丶~·\s]+?)(?=\s|$|：|:)/g);
    return tokens.map((tok, i) =>
      tok.startsWith('@') ? (
        <span key={i} className="text-[#0077CC] font-medium">
          {tok}
        </span>
      ) : (
        <React.Fragment key={i}>{tok}</React.Fragment>
      )
    );
  };

  return (
    <main className="flex-1 flex bg-[#F2F2F3] min-w-0 relative overflow-hidden">
      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Chat Header matching screenshot 1:1 */}
        <header className="h-[54px] px-5 border-b border-[#E5E5E7] flex items-center justify-between shrink-0 select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="text-[16px] font-semibold text-[#1C1C1E] truncate">
              {conversation.title}
            </h1>
            {conversation.type === 'group' && (
              <span className="text-[12px] text-[#8E8E93] font-normal">
                ({memberAgents.length + 1})
              </span>
            )}
            {dept && (
              <span
                onClick={onToggleRightDrawer}
                className="hidden md:inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-black/[0.04] text-[#66666A] hover:bg-black/[0.08] cursor-pointer transition-colors"
                title="点击查看所属部门与Agent编制"
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: dept.color }}
                />
                {dept.name}
              </span>
            )}
          </div>

          {/* Right 6 Action Icons matching screenshot 1:1 */}
          <div className="flex items-center gap-[18px] text-[#222225]">
            <button
              onClick={() =>
                triggerToast(`已开启与「${conversation.title}」的实时语音指令通道`)
              }
              className="hover:text-[#0099FF] transition-colors cursor-pointer"
              title="语音通话 / 实时语音下达指令"
            >
              <Phone className="w-[18px] h-[18px] stroke-[1.6]" />
            </button>

            <button
              onClick={() =>
                triggerToast(`已接入「${conversation.title}」虚拟演播室视频流`)
              }
              className="hover:text-[#0099FF] transition-colors cursor-pointer"
              title="视频督导 / 预览成片画面"
            >
              <Video className="w-[19px] h-[19px] stroke-[1.6]" />
            </button>

            <button
              onClick={() =>
                triggerToast('已打开 Agent 远程渲染桌面共享 (FFmpeg 1080×1920 实时管线)')
              }
              className="hover:text-[#0099FF] transition-colors cursor-pointer"
              title="屏幕共享 · 查看 Agent 实时桌面沙盒"
            >
              <Monitor className="w-[18px] h-[18px] stroke-[1.6]" />
            </button>

            {/* Remote control / Multi-Agent Collaboration icon with chevron */}
            <button
              onClick={() => onTriggerAgentCollab(conversation.id)}
              className="flex items-center gap-0.5 hover:text-[#0099FF] transition-colors cursor-pointer group"
              title="触发多 Agent 员工自主协同讨论 (员工之间自动开会交接)"
            >
              <MonitorSmartphone className="w-[18px] h-[18px] stroke-[1.6]" />
              <ChevronDown className="w-3 h-3 text-[#7A7A7E] group-hover:text-[#0099FF]" />
            </button>

            {/* Add Agent to Chat (Circle Plus) */}
            <div className="relative flex items-center">
              <button
                onClick={() => setShowAddMemberMenu((v) => !v)}
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="拉入其他部门的 Agent 员工参与协同 / 聘用新员工"
              >
                <PlusCircle className="w-[18px] h-[18px] stroke-[1.6]" />
              </button>

              {showAddMemberMenu && (
                <>
                  <div
                    className="fixed inset-0 z-20"
                    onClick={() => setShowAddMemberMenu(false)}
                  />
                  <div className="absolute right-0 top-8 w-64 bg-white rounded-xl shadow-xl border border-[#E5E5E7] p-2.5 z-30">
                    <div className="text-[12px] font-semibold text-[#1C1C1E] px-2 py-1 flex items-center justify-between">
                      <span>拉入公司其他 Agent 员工</span>
                      <span className="text-[11px] text-[#8E8E93] font-normal">
                        跨部门协同
                      </span>
                    </div>
                    <div className="max-h-52 overflow-y-auto my-1 space-y-0.5">
                      {nonMemberAgents.length === 0 ? (
                        <div className="text-[12px] text-[#8E8E93] px-2 py-3 text-center">
                          当前所有在职 Agent 均已在会话中
                        </div>
                      ) : (
                        nonMemberAgents.map((ag) => (
                          <button
                            key={ag.id}
                            onClick={() => {
                              onPullAgentToChat(conversation.id, ag.id);
                              setShowAddMemberMenu(false);
                              triggerToast(`已将「${ag.name}」拉入当前会话协同`);
                            }}
                            className="w-full px-2 py-1.5 rounded-lg hover:bg-[#F2F2F3] flex items-center gap-2 text-left cursor-pointer"
                          >
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
                              <div className="text-[10.5px] text-[#8E8E93] truncate">
                                {ag.role}
                              </div>
                            </div>
                            <span className="text-[11px] text-[#0099FF] font-medium">
                              +拉入
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                    <button
                      onClick={() => {
                        setShowAddMemberMenu(false);
                        onOpenHireModal();
                      }}
                      className="w-full mt-1 py-1.5 bg-[#0099FF]/10 hover:bg-[#0099FF]/15 text-[#0077CC] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <UserPlus className="w-3.5 h-3.5" />
                      <span>去人才市场聘用新 Agent</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* More (...) -> Toggles Agent Dossier / Group Org Drawer */}
            <button
              onClick={onToggleRightDrawer}
              className={`hover:text-[#0099FF] transition-colors cursor-pointer ${
                rightDrawerOpen ? 'text-[#0099FF]' : ''
              }`}
              title="查看当前 Agent 档案 / brief.md 规范 / 群成员架构"
            >
              <MoreHorizontal className="w-[19px] h-[19px] stroke-[1.7]" />
            </button>
          </div>
        </header>

        {/* Floating Toast notification */}
        {actionToast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 bg-[#1C1C1E]/90 text-white text-[12.5px] px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-1.5 pointer-events-none">
            <CheckCircle2 className="w-3.5 h-3.5 text-[#27C93F]" />
            <span>{actionToast}</span>
          </div>
        )}

        {/* Scrollable Message Stream */}
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-4 select-text">
          {conversation.messages.map((msg) => {
            // 1. System notice
            if (msg.type === 'system') {
              return (
                <div key={msg.id} className="flex justify-center my-2">
                  <span className="text-[11.5px] text-[#8E8E93] bg-black/[0.04] px-3 py-1 rounded-full">
                    {msg.text}
                  </span>
                </div>
              );
            }

            // 2. Exact Deliverable Card from screenshot (m-sl-1 or newly generated deliverables)
            if (msg.type === 'deliverable-card' && msg.deliverable) {
              const d = msg.deliverable;
              return (
                <div key={msg.id} className="space-y-3">
                  {msg.showTimeHeader && (
                    <div className="text-center text-[12px] text-[#9E9EA3] my-3 select-none">
                      {msg.showTimeHeader}
                    </div>
                  )}
                  <div className="flex justify-end items-start gap-2.5">
                    <div className="w-full max-w-[490px] bg-white rounded-[10px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] px-5 pt-2.5 pb-3 text-[#222225] border border-black/[0.03]">
                      {/* Faint top cropped line matching screenshot */}
                      <div className="text-[9.5px] text-[#99999E] leading-none mb-2 select-none">
                        ⋯ 思考与执行完毕
                      </div>

                      <p className="text-[10.5px] text-[#2C2C2E] mb-2 leading-normal">
                        {d.introText}
                      </p>

                      <div className="text-[11.5px] font-bold text-[#1C1C1E] mb-1.5">
                        {d.title}
                      </div>

                      <div className="text-[10px] text-[#3A3A3C] space-y-0.5 leading-[1.6]">
                        <div>
                          作品ID{' '}
                          <span className="font-mono bg-[#F2F2F5] px-1 py-[1px] rounded text-[#1C1C1E]">
                            {d.workId}
                          </span>{' '}
                          账号「{d.accountName}」 状态{' '}
                          <span className="font-mono bg-[#F2F2F5] px-1 py-[1px] rounded">
                            {d.status}
                          </span>
                        </div>
                        <div>官方活动已报名：{d.campaigns}</div>
                        <div>
                          链接：
                          <a
                            href={d.link}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#1677FF] hover:underline break-all"
                          >
                            {d.link}
                          </a>
                        </div>
                      </div>

                      {/* 成片 section */}
                      <div className="text-[11px] font-bold text-[#1C1C1E] mt-2.5 mb-1">
                        {d.specsTitle}
                      </div>
                      <ul className="text-[10px] text-[#2C2C2E] space-y-1 pl-3 list-disc leading-[1.55]">
                        {d.specs.map((s, idx) => (
                          <li key={idx}>{s}</li>
                        ))}
                      </ul>

                      {/* 这轮最关键的三个坑（都写进 brief.md 了） */}
                      <div className="text-[11px] font-bold text-[#1C1C1E] mt-3 mb-1">
                        {d.pitfallsTitle}
                      </div>
                      <ol className="text-[9.8px] text-[#2C2C2E] space-y-1.5 pl-3.5 list-decimal leading-[1.58]">
                        {d.pitfalls.map((pit, idx) => (
                          <li key={idx}>{pit}</li>
                        ))}
                      </ol>

                      {/* Embedded mini footer bar inside the screenshot card */}
                      {d.footerPlaceholder && (
                        <div className="mt-3 pt-2 border-t border-[#F0F0F2] flex items-center gap-2 text-[9.5px] text-[#A0A0A5] select-none">
                          <span className="w-3.5 h-3.5 rounded-full bg-[#E8F3FF] text-[#1677FF] flex items-center justify-center text-[8px]">
                            ↗
                          </span>
                          <span className="truncate">{d.footerPlaceholder}</span>
                        </div>
                      )}
                    </div>

                    {/* Top-right subtle avatar indicator */}
                    <div className="w-[34px] shrink-0 flex justify-center">
                      <AvatarIcon
                        type={msg.senderAvatarType || 'founder-girl'}
                        name={msg.senderName}
                        size="sm"
                        className="w-[34px] h-[34px]"
                      />
                    </div>
                  </div>
                </div>
              );
            }

            // 3. User (Boss / Founder) right-aligned sky-blue bubble matching screenshot 1:1
            const isUser = msg.senderId === 'user';
            if (isUser) {
              return (
                <div key={msg.id} className="space-y-3">
                  {msg.showTimeHeader && (
                    <div className="text-center text-[12px] text-[#9E9EA3] my-3 select-none">
                      {msg.showTimeHeader}
                    </div>
                  )}
                  <div className="flex justify-end items-start gap-2.5">
                    <div className="bg-[#D2ECFF] text-[#1C1C1E] text-[14.5px] leading-[1.55] px-3.5 py-2.5 rounded-[10px] max-w-[660px] break-words shadow-[0_0.5px_1px_rgba(0,0,0,0.03)]">
                      {renderMessageTextWithLinks(msg)}
                    </div>
                    <AvatarIcon
                      type="founder-girl"
                      name="丶殇泪"
                      size="sm"
                      className="w-[34px] h-[34px] shrink-0 mt-0.5"
                    />
                  </div>
                </div>
              );
            }

            // 4. Agent Employee left-aligned bubble (supports 1v1 and multi-agent group replies)
            const senderAgent = agents.find((a) => a.id === msg.senderId);
            return (
              <div key={msg.id} className="space-y-2">
                {msg.showTimeHeader && (
                  <div className="text-center text-[12px] text-[#9E9EA3] my-3 select-none">
                    {msg.showTimeHeader}
                  </div>
                )}
                <div className="flex items-start gap-2.5">
                  <AvatarIcon
                    type={msg.senderAvatarType || senderAgent?.avatarType || 'custom'}
                    avatarUrl={msg.senderAvatarUrl || senderAgent?.avatarUrl}
                    name={msg.senderName}
                    size="sm"
                    className="w-[34px] h-[34px] shrink-0 mt-0.5"
                  />
                  <div className="flex flex-col items-start max-w-[650px]">
                    <div className="flex items-center gap-1.5 mb-1 px-0.5">
                      <span className="text-[12px] font-medium text-[#66666A]">
                        {msg.senderName}
                      </span>
                      {(msg.senderRole || senderAgent?.role) && (
                        <span className="text-[10.5px] px-1.5 py-[1px] rounded bg-black/[0.05] text-[#6E6E73]">
                          {msg.senderRole || `${senderAgent?.role} · ${senderAgent?.level}`}
                        </span>
                      )}
                      <span className="text-[10.5px] text-[#AEAEB2]">{msg.timestamp}</span>
                    </div>

                    <div className="bg-white text-[#1C1C1E] text-[14px] leading-[1.58] px-3.5 py-2.5 rounded-[10px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] border border-black/[0.03] whitespace-pre-wrap break-words">
                      {renderMessageTextWithLinks(msg)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* Multi-agent typing / working indicator */}
          {typingAgents.length > 0 && (
            <div className="flex items-center gap-2 text-[12px] text-[#0077CC] bg-[#E6F4FF] px-3 py-1.5 rounded-full w-fit animate-pulse">
              <Sparkles className="w-3.5 h-3.5" />
              <span>
                {typingAgents.join('、')} 正在协同处理并调用沙盒工具...
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Bottom Composer Area matching screenshot 1:1 */}
        <div className="h-[175px] border-t border-[#E4E4E6] bg-[#F2F2F3] flex flex-col shrink-0 relative select-none">
          {/* Mention Popup (@Agent) */}
          {showMentionPopup && (
            <div className="absolute bottom-[145px] left-4 w-64 bg-white rounded-xl shadow-xl border border-[#E5E5E7] py-1.5 z-30">
              <div className="px-3 py-1 text-[11px] font-semibold text-[#8E8E93] border-b border-[#F2F2F3]">
                @提及会话内的 Agent 员工指派任务
              </div>
              <button
                onClick={() => handleInsertMention('全体成员')}
                className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[#F2F2F3] text-[#FF4D4F] font-medium flex items-center justify-between cursor-pointer"
              >
                <span>@全体成员</span>
                <span className="text-[11px] text-[#8E8E93]">群发指令</span>
              </button>
              {memberAgents.map((ag) => (
                <button
                  key={ag.id}
                  onClick={() => handleInsertMention(ag.name)}
                  className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[#F2F2F3] text-[#1C1C1E] flex items-center gap-2 cursor-pointer"
                >
                  <AvatarIcon
                    type={ag.avatarType}
                    avatarUrl={ag.avatarUrl}
                    name={ag.name}
                    size="xs"
                  />
                  <span className="truncate font-medium">{ag.name}</span>
                  <span className="text-[10.5px] text-[#8E8E93] ml-auto shrink-0">
                    {ag.level}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Quick Prompts Popup */}
          {showQuickPrompts && (
            <div className="absolute bottom-[145px] left-4 w-[420px] bg-white rounded-xl shadow-xl border border-[#E5E5E7] p-2 z-30">
              <div className="px-2 py-1 text-[11.5px] font-semibold text-[#1C1C1E] flex items-center justify-between">
                <span>⚡ 常用 OPC 老板指令模板</span>
                <button
                  onClick={() => setShowQuickPrompts(false)}
                  className="text-[11px] text-[#8E8E93] hover:text-[#1C1C1E]"
                >
                  关闭
                </button>
              </div>
              <div className="space-y-1 mt-1">
                {QUICK_PROMPTS.map((qp, idx) => (
                  <button
                    key={idx}
                    onClick={() => {
                      setInputText(qp);
                      setShowQuickPrompts(false);
                      textareaRef.current?.focus();
                    }}
                    className="w-full text-left text-[12px] text-[#2C2C2E] hover:bg-[#F2F5FA] hover:text-[#0066CC] px-2.5 py-1.5 rounded-lg transition-colors cursor-pointer"
                  >
                    {qp}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Toolbar Row matching screenshot 1:1 */}
          <div className="px-4 pt-2.5 pb-1.5 flex items-center justify-between text-[#2C2C2E]">
            <div className="flex items-center gap-[15px]">
              {/* 1. Emoji / Quick Prompts */}
              <button
                onClick={() => setShowQuickPrompts((v) => !v)}
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="快捷老板指令模板 / 表情"
              >
                <Smile className="w-[19px] h-[19px] stroke-[1.6]" />
              </button>

              {/* 2. Scissors + chevron */}
              <button
                onClick={() => {
                  onSendMessage(
                    conversation.id,
                    '9.76 复制打开抖音，看看【陈乔维Justin的作品】AI反向操作才是王炸！ 别再只会向 AI 要答案了... https://v.douyin.com/BN3hie3fIAo/ 抓一下这个账号近30条视频数据，找出超均值3倍的爆款脚本结构'
                  );
                }}
                className="flex items-center gap-0.5 hover:text-[#0099FF] transition-colors cursor-pointer"
                title="一键投递抖音爆款链接截图并触发拆解"
              >
                <Scissors className="w-[18px] h-[18px] stroke-[1.6]" />
                <ChevronDown className="w-3 h-3 text-[#7A7A7E]" />
              </button>

              {/* 3. Folder + chevron (brief.md) */}
              <button
                onClick={() => {
                  onToggleRightDrawer();
                  triggerToast('已在右侧打开当前部门与 Agent 的 brief.md 记忆文件');
                }}
                className="flex items-center gap-0.5 hover:text-[#0099FF] transition-colors cursor-pointer"
                title="发送或挂载 brief.md / SOP 规范文件"
              >
                <Folder className="w-[18px] h-[18px] stroke-[1.6]" />
                <ChevronDown className="w-3 h-3 text-[#7A7A7E]" />
              </button>

              {/* 4. Picture */}
              <button
                onClick={() =>
                  onSendMessage(
                    conversation.id,
                    '按 1080×1920 / 30fps / 23个纯影像镜头 规范生成新一期分镜并校验字幕对比度 ≥ 3:1'
                  )
                }
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="发送视觉分镜与纯影像质检要求"
              >
                <ImageIcon className="w-[18px] h-[18px] stroke-[1.6]" />
              </button>

              {/* 5. Shake / Vibrate icon matching screenshot */}
              <button
                onClick={() => {
                  onSendMessage(
                    conversation.id,
                    '⚡ [窗口抖动] 老板催办：请当前会话所有 Agent 立即汇报手头任务进度与卡点！'
                  );
                }}
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="窗口抖动 · 一键唤醒并催办所有 Agent 员工"
              >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="7"
                    y="5"
                    width="10"
                    height="14"
                    rx="1.8"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M3.5 8L2 10L3.5 12L2 14L3.5 16"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M20.5 8L22 10L20.5 12L22 14L20.5 16"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {/* 6. Red Packet / Token Bonus icon matching screenshot */}
              <button
                onClick={() => {
                  onSendMessage(
                    conversation.id,
                    '🧧 [发放算力激励红包] 追加 100,000 Claude-3.7 Thinking Tokens 预算，请团队优先保障本条短剧成片质量！'
                  );
                }}
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="发放 Token 算力红包激励 Agent 深度推理"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <rect
                    x="5"
                    y="3.5"
                    width="14"
                    height="17"
                    rx="2"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <path
                    d="M5 9.5C8.5 12 15.5 12 19 9.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <circle cx="12" cy="10.8" r="1.5" fill="currentColor" />
                </svg>
              </button>

              {/* 7. Microphone */}
              <button
                onClick={() =>
                  triggerToast('按住可录入老板语音指令，自动转写并分发给对应部门 Agent')
                }
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="语音输入指令"
              >
                <Mic className="w-[18px] h-[18px] stroke-[1.6]" />
              </button>

              {/* 8. Desktop+Mobile icon matching screenshot */}
              <button
                onClick={() => onTriggerAgentCollab(conversation.id)}
                className="hover:text-[#0099FF] transition-colors cursor-pointer"
                title="启动员工间自主协同讨论 (Agent 之间自动对话交接工作)"
              >
                <MonitorSmartphone className="w-[18px] h-[18px] stroke-[1.6]" />
              </button>

              {/* Subtle OPC helper buttons for @Agent & Multi-Agent Sync */}
              <div className="hidden lg:flex items-center gap-1.5 ml-2 pl-2 border-l border-[#DCDCE0]">
                <button
                  onClick={() => setShowMentionPopup((v) => !v)}
                  className="flex items-center gap-1 text-[11.5px] text-[#555558] hover:text-[#0099FF] bg-black/[0.04] hover:bg-[#0099FF]/10 px-2 py-0.5 rounded transition-colors cursor-pointer"
                >
                  <AtSign className="w-3 h-3" />
                  <span>提及员工</span>
                </button>
                <button
                  onClick={() => onTriggerAgentCollab(conversation.id)}
                  className="flex items-center gap-1 text-[11.5px] text-[#0077CC] bg-[#0099FF]/10 hover:bg-[#0099FF]/15 px-2 py-0.5 rounded font-medium transition-colors cursor-pointer"
                >
                  <Zap className="w-3 h-3" />
                  <span>让Agent员工自主协同</span>
                </button>
              </div>
            </div>

            {/* Right Clock Icon matching screenshot 1:1 */}
            <button
              onClick={onToggleRightDrawer}
              className="hover:text-[#0099FF] transition-colors cursor-pointer"
              title="查看历史交付记录与 brief.md 迭代日志"
            >
              <Clock className="w-[18px] h-[18px] stroke-[1.6]" />
            </button>
          </div>

          {/* Textarea Input matching screenshot */}
          <div className="flex-1 px-4 pt-1 pb-2 flex flex-col">
            <textarea
              ref={textareaRef}
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder=""
              className="w-full flex-1 bg-transparent resize-none outline-none text-[14px] text-[#1C1C1E] leading-relaxed select-text"
            />
            {inputText.trim().length > 0 && (
              <div className="flex items-center justify-end gap-2 pt-1">
                <span className="text-[11px] text-[#9E9EA3]">
                  Enter 发送 · Shift+Enter 换行
                </span>
                <button
                  onClick={() => {
                    onSendMessage(conversation.id, inputText.trim());
                    setInputText('');
                  }}
                  className="bg-[#0099FF] hover:bg-[#0088E6] text-white text-[12px] font-medium px-3 py-1 rounded-md flex items-center gap-1 transition-colors cursor-pointer"
                >
                  <Send className="w-3 h-3" />
                  <span>发送</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Right Collapsible HR Dossier & Group Member Drawer */}
      {rightDrawerOpen && (
        <aside className="w-[290px] bg-[#F8F8FA] border-l border-[#E5E5E7] flex flex-col shrink-0 select-none overflow-y-auto">
          <div className="px-4 py-3.5 border-b border-[#E5E5E7] flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-[#1C1C1E]">
              <Briefcase className="w-4 h-4 text-[#0099FF]" />
              <span>
                {conversation.type === 'group' ? '部门群组编制与Agent成员' : 'Agent 员工 HR 档案'}
              </span>
            </div>
            <button
              onClick={onToggleRightDrawer}
              className="text-[12px] text-[#8E8E93] hover:text-[#1C1C1E] cursor-pointer"
            >
              收起
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Department Card */}
            {dept && (
              <div className="bg-white rounded-xl p-3 border border-[#E5E5E7] shadow-2xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-mono text-[#8E8E93]">{dept.code}</span>
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: dept.color }}
                  />
                </div>
                <div className="text-[13.5px] font-semibold text-[#1C1C1E]">{dept.name}</div>
                <p className="text-[11.5px] text-[#6E6E73] mt-1 leading-relaxed">
                  {dept.description}
                </p>
              </div>
            )}

            {/* In-chat Agent Employees */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12px] font-semibold text-[#555558]">
                  当前会话在岗 Agent ({memberAgents.length})
                </span>
                <button
                  onClick={() => setShowAddMemberMenu(true)}
                  className="text-[11.5px] text-[#0077CC] hover:underline flex items-center gap-0.5 cursor-pointer"
                >
                  <UserPlus className="w-3 h-3" />
                  <span>拉入员工</span>
                </button>
              </div>

              <div className="space-y-2">
                {memberAgents.map((ag) => (
                  <div
                    key={ag.id}
                    className="bg-white rounded-xl p-3 border border-[#E5E5E7] shadow-2xs space-y-2"
                  >
                    <div className="flex items-center gap-2.5">
                      <AvatarIcon
                        type={ag.avatarType}
                        avatarUrl={ag.avatarUrl}
                        name={ag.name}
                        size="sm"
                        showOnlineBadge
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] font-semibold text-[#1C1C1E] truncate">
                            {ag.name}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 bg-[#0099FF]/10 text-[#0077CC] rounded font-semibold">
                            {ag.level}
                          </span>
                        </div>
                        <div className="text-[11px] text-[#8E8E93] truncate">{ag.role}</div>
                      </div>
                    </div>

                    <div className="text-[11px] text-[#555558] bg-[#F4F4F6] px-2 py-1 rounded flex items-center justify-between">
                      <span className="truncate">引擎: {ag.model}</span>
                      <span className="text-[#10B981] font-medium shrink-0 ml-1">
                        {ag.tokenCostPerDay}
                      </span>
                    </div>

                    {/* Skills */}
                    <div className="flex flex-wrap gap-1">
                      {ag.skills.map((sk) => (
                        <span
                          key={sk}
                          className="text-[10px] px-1.5 py-0.5 bg-[#F2F2F5] text-[#555558] rounded"
                        >
                          {sk}
                        </span>
                      ))}
                    </div>

                    {/* brief.md viewer / editor */}
                    <div className="pt-1 border-t border-[#F0F0F2]">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-mono font-semibold text-[#3A3A3C] flex items-center gap-1">
                          <FileText className="w-3 h-3 text-[#0099FF]" />
                          brief.md 踩坑记忆
                        </span>
                        {editingBriefAgentId === ag.id ? (
                          <button
                            onClick={() => {
                              onUpdateAgentBrief(ag.id, briefDraft);
                              setEditingBriefAgentId(null);
                              triggerToast(`已更新「${ag.name}」的 brief.md 记忆规范`);
                            }}
                            className="text-[11px] text-[#0099FF] font-semibold cursor-pointer"
                          >
                            保存
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingBriefAgentId(ag.id);
                              setBriefDraft(ag.briefMd);
                            }}
                            className="text-[11px] text-[#8E8E93] hover:text-[#0099FF] cursor-pointer"
                          >
                            编辑
                          </button>
                        )}
                      </div>

                      {editingBriefAgentId === ag.id ? (
                        <textarea
                          value={briefDraft}
                          onChange={(e) => setBriefDraft(e.target.value)}
                          rows={5}
                          className="w-full text-[11px] font-mono bg-[#F7F7F9] border border-[#0099FF] rounded p-1.5 text-[#1C1C1E] outline-none select-text"
                        />
                      ) : (
                        <pre className="text-[10.5px] font-mono text-[#4A4A4E] bg-[#F7F7F9] p-2 rounded whitespace-pre-wrap leading-relaxed select-text">
                          {ag.briefMd}
                        </pre>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
      )}
    </main>
  );
};
