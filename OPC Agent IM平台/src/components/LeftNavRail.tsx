import React from 'react';
import { Settings } from 'lucide-react';
import { NavTab } from '../types/im';

interface LeftNavRailProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onQuickJumpConversation: (convId: string) => void;
  unreadTotal: number;
  candidateCount: number;
}

export const LeftNavRail: React.FC<LeftNavRailProps> = ({
  activeTab,
  onSelectTab,
  onQuickJumpConversation,
  candidateCount,
}) => {
  return (
    <aside className="w-[58px] bg-[#F2F2F3] border-r border-[#E5E5E7] flex flex-col items-center justify-between py-3.5 select-none shrink-0">
      {/* Top 6 Icons matching screenshot 1:1 */}
      <div className="flex flex-col items-center gap-4">
        {/* 1. IM Messages (Filled Blue Speech Bubble with 2 dots) */}
        <button
          onClick={() => onSelectTab('im')}
          className="w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer hover:bg-black/[0.04] transition-colors"
          title="IM 消息工作台 (Agent私聊与部门群组)"
        >
          {activeTab === 'im' ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3C6.8 3 2.7 6.68 2.7 11.35C2.7 13.78 3.85 15.96 5.72 17.46C5.98 17.67 6.08 18.02 5.97 18.34L5.26 20.4C5.11 20.83 5.56 21.22 5.96 21.01L8.24 19.83C8.51 19.69 8.83 19.65 9.13 19.72C10.04 19.93 11.01 20.05 12 20.05C17.2 20.05 21.3 16.37 21.3 11.7C21.3 7.03 17.2 3 12 3Z"
                fill="#0099FF"
              />
              <circle cx="9.5" cy="11.5" r="1.35" fill="#FFFFFF" />
              <circle cx="14.5" cy="11.5" r="1.35" fill="#FFFFFF" />
            </svg>
          ) : (
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 3.5C7.03 3.5 3 6.99 3 11.3C3 13.57 4.1 15.61 5.88 17.02L5.2 19.8L8.15 18.45C9.35 18.87 10.65 19.1 12 19.1C16.97 19.1 21 15.61 21 11.3C21 6.99 16.97 3.5 12 3.5Z"
                stroke="#222225"
                strokeWidth="1.65"
                strokeLinejoin="round"
              />
              <circle cx="9.5" cy="11.3" r="1.2" fill="#222225" />
              <circle cx="14.5" cy="11.3" r="1.2" fill="#222225" />
            </svg>
          )}
        </button>

        {/* 2. Contacts / HR 组织架构 (User Icon with flat base line matching screenshot) */}
        <button
          onClick={() => onSelectTab('org')}
          className={`w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer transition-colors ${
            activeTab === 'org' ? 'bg-[#0099FF]/12 text-[#0099FF]' : 'text-[#222225] hover:bg-black/[0.04]'
          }`}
          title="HR 组织架构 & Agent 员工编制管理"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="8"
              r="3.6"
              stroke="currentColor"
              strokeWidth="1.7"
            />
            <path
              d="M5.5 19.2C5.9 15.7 8.4 13.8 12 13.8C15.6 13.8 18.1 15.7 18.5 19.2H5.5Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* 3. Star with Red Dot -> Agent 人才聘用市场 (Hire AI Agents) */}
        <button
          onClick={() => onSelectTab('market')}
          className={`w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer transition-colors ${
            activeTab === 'market' ? 'bg-[#0099FF]/12 text-[#0099FF]' : 'text-[#222225] hover:bg-black/[0.04]'
          }`}
          title={`Agent 人才聘用市场 (${candidateCount}名候选Agent待聘用)`}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3.4L14.55 8.6L20.3 9.42L16.14 13.47L17.12 19.19L12 16.49L6.88 19.19L7.86 13.47L3.7 9.42L9.45 8.6L12 3.4Z"
              stroke="currentColor"
              strokeWidth="1.65"
              strokeLinejoin="round"
            />
          </svg>
          {/* Red dot matching screenshot */}
          <span className="absolute top-1.5 right-1.5 w-[7px] h-[7px] rounded-full bg-[#FF4D4F]" />
        </button>

        {/* 4. Hash (#) -> 部门群组频道 & 多Agent协同流 */}
        <button
          onClick={() => onSelectTab('channels')}
          className={`w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer transition-colors ${
            activeTab === 'channels' ? 'bg-[#0099FF]/12 text-[#0099FF]' : 'text-[#222225] hover:bg-black/[0.04]'
          }`}
          title="OPC 部门群组频道与多Agent协同广场"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <line x1="4.5" y1="9" x2="19.5" y2="9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <line x1="4.5" y1="15" x2="19.5" y2="15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <line x1="10" y1="4.5" x2="8" y2="19.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <line x1="16" y1="4.5" x2="14" y2="19.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </button>

        {/* 5. Up-arrow in rounded square -> 成片交付物与 brief.md 知识库 */}
        <button
          onClick={() => onSelectTab('deliverables')}
          className={`w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer transition-colors ${
            activeTab === 'deliverables'
              ? 'bg-[#0099FF]/12 text-[#0099FF]'
              : 'text-[#222225] hover:bg-black/[0.04]'
          }`}
          title="AI短剧交付物归档 & brief.md 踩坑库"
        >
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <rect
              x="4"
              y="4"
              width="16"
              height="16"
              rx="4.2"
              stroke="currentColor"
              strokeWidth="1.65"
            />
            <path
              d="M12 15.5V8.5M12 8.5L9.2 11.3M12 8.5L14.8 11.3"
              stroke="currentColor"
              strokeWidth="1.65"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* 6. 9-Dots Grid -> Agent Skills & MCP 工具矩阵 */}
        <button
          onClick={() => onSelectTab('skills')}
          className={`w-10 h-10 rounded-xl flex items-center justify-center relative group cursor-pointer transition-colors ${
            activeTab === 'skills' ? 'bg-[#0099FF]/12 text-[#0099FF]' : 'text-[#222225] hover:bg-black/[0.04]'
          }`}
          title="Agent 技能包与 MCP 算力工具箱"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            {[4, 10, 16].map((cx) =>
              [4, 10, 16].map((cy) => (
                <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.45" fill="currentColor" />
              ))
            )}
          </svg>
        </button>
      </div>

      {/* Bottom quick jumps, settings and hamburger menu */}
      <div className="flex flex-col items-center gap-3.5">
        {/* Mail icon with red dot */}
        <button
          onClick={() => {
            onSelectTab('im');
            onQuickJumpConversation('conv-mail');
          }}
          className="w-9 h-9 rounded-lg flex items-center justify-center relative text-[#3A3A3D] hover:bg-black/[0.04] transition-colors cursor-pointer"
          title="QQ邮箱提醒 · 抖音精选官方活动通知"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5.5" width="17" height="13" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <path d="M4 7L12 12.5L20 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="absolute top-1 right-1 w-[7px] h-[7px] rounded-full bg-[#FF4D4F]" />
        </button>

        {/* Device / Smartphone icon */}
        <button
          onClick={() => {
            onSelectTab('im');
            onQuickJumpConversation('conv-phone');
          }}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-[#3A3A3D] hover:bg-black/[0.04] transition-colors cursor-pointer"
          title="我的手机 · 移动端算力沙盒同步"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="6.5" y="3.5" width="11" height="17" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="12" cy="17.5" r="0.9" fill="currentColor" />
          </svg>
        </button>

        {/* Settings (gear) -> 通用 / 模型 / 自检 / 关于 */}
        <button
          onClick={() => onSelectTab('settings')}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
            activeTab === 'settings' ? 'bg-[#0099FF]/12 text-[#0099FF]' : 'text-[#3A3A3D] hover:bg-black/[0.04]'
          }`}
          title="设置"
          aria-label="设置"
        >
          <Settings className="w-5 h-5" strokeWidth={1.5} />
        </button>

        {/* Hamburger Menu icon */}
        <button
          onClick={() => onSelectTab(activeTab === 'org' ? 'im' : 'org')}
          className="w-9 h-9 rounded-lg flex items-center justify-center text-[#3A3A3D] hover:bg-black/[0.04] transition-colors cursor-pointer"
          title="OPC 企业总控与 HR 架构设置"
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
            <line x1="4.5" y1="6.5" x2="19.5" y2="6.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4.5" y1="12" x2="19.5" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <line x1="4.5" y1="17.5" x2="19.5" y2="17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </aside>
  );
};
