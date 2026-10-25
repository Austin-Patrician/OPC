import React, { useState } from 'react';
import { BellOff, Network, Plus, Search, UserPlus, Users } from 'lucide-react';
import { Conversation } from '../types/im';
import { AvatarIcon } from './AvatarIcon';

interface SessionListProps {
  conversations: Conversation[];
  activeConversationId: string;
  onSelectConversation: (id: string) => void;
  onOpenHireModal: () => void;
  onOpenCreateGroupModal: () => void;
  onSwitchToOrg: () => void;
}

export const SessionList: React.FC<SessionListProps> = ({
  conversations,
  activeConversationId,
  onSelectConversation,
  onOpenHireModal,
  onOpenCreateGroupModal,
  onSwitchToOrg,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showPlusMenu, setShowPlusMenu] = useState(false);

  const filtered = conversations.filter(
    (c) =>
      c.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <section className="w-[276px] bg-[#F9F9FA] border-r border-[#E6E6E8] flex flex-col select-none shrink-0 relative">
      {/* Top Search & Plus bar matching screenshot 1:1 */}
      <div className="px-3 pt-3 pb-2.5 flex items-center gap-2">
        <div className="flex-1 h-[30px] bg-[#EFEFF1] rounded-[6px] px-2.5 flex items-center gap-1.5 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#0099FF]">
          <Search className="w-3.5 h-3.5 text-[#9E9EA3] shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索"
            className="w-full bg-transparent text-[13px] text-[#1C1C1E] placeholder-[#9E9EA3] outline-none"
          />
        </div>

        <div className="relative">
          <button
            onClick={() => setShowPlusMenu((v) => !v)}
            className="w-[30px] h-[30px] rounded-[6px] bg-[#EFEFF1] hover:bg-[#E4E4E7] flex items-center justify-center text-[#7A7A7E] transition-colors cursor-pointer"
            title="聘用Agent员工 / 创建部门群聊 / HR组织架构"
          >
            <Plus className="w-4 h-4 stroke-[1.8]" />
          </button>

          {showPlusMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowPlusMenu(false)} />
              <div className="absolute right-0 top-9 w-48 bg-white rounded-lg shadow-lg border border-[#E5E5E7] py-1.5 z-30 text-[13px]">
                <button
                  onClick={() => {
                    setShowPlusMenu(false);
                    onOpenHireModal();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-[#F2F2F3] flex items-center gap-2.5 text-[#1C1C1E] cursor-pointer"
                >
                  <UserPlus className="w-4 h-4 text-[#0099FF]" />
                  <span>聘用新 Agent 员工</span>
                </button>
                <button
                  onClick={() => {
                    setShowPlusMenu(false);
                    onOpenCreateGroupModal();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-[#F2F2F3] flex items-center gap-2.5 text-[#1C1C1E] cursor-pointer"
                >
                  <Users className="w-4 h-4 text-[#10B981]" />
                  <span>组建多Agent项目群</span>
                </button>
                <div className="my-1 border-t border-[#EFEFF1]" />
                <button
                  onClick={() => {
                    setShowPlusMenu(false);
                    onSwitchToOrg();
                  }}
                  className="w-full px-3 py-2 text-left hover:bg-[#F2F2F3] flex items-center gap-2.5 text-[#1C1C1E] cursor-pointer"
                >
                  <Network className="w-4 h-4 text-[#8B5CF6]" />
                  <span>管理 HR 组织架构</span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Session List Items */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-[2px]">
        {filtered.map((conv) => {
          const isSelected = conv.id === activeConversationId;
          return (
            <div
              key={conv.id}
              onClick={() => onSelectConversation(conv.id)}
              className={`group flex items-center px-2.5 py-[9px] rounded-[8px] cursor-pointer transition-colors ${
                isSelected ? 'bg-[#E5E5E7]' : 'hover:bg-[#EFEFF1]'
              }`}
            >
              <AvatarIcon
                type={conv.avatarType}
                avatarUrl={conv.avatarUrl}
                name={conv.title}
                size="md"
              />

              <div className="flex-1 min-w-0 ml-2.5">
                {/* Top line: Title + Timestamp */}
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[14px] font-medium text-[#1C1C1E] truncate leading-snug">
                    {conv.title}
                  </span>
                  <span className="text-[11.5px] text-[#9E9EA3] shrink-0 leading-none">
                    {conv.timestamp}
                  </span>
                </div>

                {/* Bottom line: Preview + Badge/Mute */}
                <div className="flex items-center justify-between mt-1 gap-1">
                  <div className="text-[12.5px] text-[#8E8E93] truncate leading-snug">
                    {conv.lastMessagePrefixHighlight && (
                      <span className="text-[#FF4D4F] mr-0.5">{conv.lastMessagePrefixHighlight}</span>
                    )}
                    <span>{conv.lastMessage}</span>
                  </div>

                  {conv.unreadDisplay ? (
                    <span className="bg-[#C6C6CA] text-white text-[10.5px] font-medium px-1.5 min-w-[18px] h-[16px] rounded-full flex items-center justify-center leading-none shrink-0">
                      {conv.unreadDisplay}
                    </span>
                  ) : conv.muted ? (
                    <BellOff className="w-[13px] h-[13px] text-[#C2C2C6] shrink-0 stroke-[1.7]" />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};
