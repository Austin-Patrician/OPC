import React, { useState } from 'react';
import { Cloud, Network, UserPlus } from 'lucide-react';
import { AvatarIcon } from './AvatarIcon';
import { NavTab } from '../types/im';
import { CompanyMark } from './onboarding/onboardingShared';
import { useOnboarding } from './onboarding/onboardingStore';

interface TopTitleBarProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  onOpenHireModal: () => void;
  agentCount: number;
  departmentCount: number;
  rightDrawerOpen: boolean;
  onToggleRightDrawer: () => void;
}

export const TopTitleBar: React.FC<TopTitleBarProps> = ({
  activeTab,
  onSelectTab,
  onOpenHireModal,
  agentCount,
  departmentCount,
  rightDrawerOpen,
  onToggleRightDrawer,
}) => {
  const [signature, setSignature] = useState('编辑个性签名');
  const [editingSig, setEditingSig] = useState(false);
  const { company } = useOnboarding();
  const companyName = company.name.trim();

  return (
    <header className="h-[42px] bg-[#EBEBEC] border-b border-[#DFDFE1] px-3.5 flex items-center justify-between select-none shrink-0">
      {/* Left: macOS traffic lights + Founder profile */}
      <div className="flex items-center gap-3.5">
        <div className="flex items-center gap-[8px] mr-1">
          <span className="w-[12px] h-[12px] rounded-full bg-[#FF5F56] border border-[#E0443E] inline-block" />
          <span className="w-[12px] h-[12px] rounded-full bg-[#FFBD2E] border border-[#DEA123] inline-block" />
          <span className="w-[12px] h-[12px] rounded-full bg-[#27C93F] border border-[#1AAB29] inline-block" />
        </div>

        {companyName && (
          <div className="flex items-center gap-1.5 pr-3.5 border-r border-black/[0.08]" title={company.vision.trim() || companyName}>
            <CompanyMark company={company} size={20} />
            <span className="text-[13px] font-semibold text-[#1C1C1E] tracking-tight max-w-[160px] truncate">{companyName}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <AvatarIcon type="founder-girl" size="xs" showTopBarBadge className="w-[26px] h-[26px]" />
          <span className="text-[14px] font-semibold text-[#1C1C1E] tracking-tight">丶殇泪</span>
          {editingSig ? (
            <input
              type="text"
              value={signature === '编辑个性签名' ? '' : signature}
              placeholder="输入OPC创始人签名..."
              autoFocus
              onChange={(e) => setSignature(e.target.value)}
              onBlur={() => {
                if (!signature.trim()) setSignature('编辑个性签名');
                setEditingSig(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  if (!signature.trim()) setSignature('编辑个性签名');
                  setEditingSig(false);
                }
              }}
              className="text-[12.5px] text-[#1C1C1E] bg-white/80 px-1.5 py-0.5 rounded border border-[#0099FF] outline-none w-48"
            />
          ) : (
            <button
              onClick={() => setEditingSig(true)}
              className="text-[12.5px] text-[#8E8E93] hover:text-[#555558] transition-colors cursor-text"
              title="点击编辑创始人个性签名"
            >
              {signature}
            </button>
          )}
        </div>
      </div>

      {/* Right: OPC Quick Status + Weather + Panel Toggle (matching screenshot) */}
      <div className="flex items-center gap-3">
        {/* Quick OPC HR Org & Hire pill */}
        <div className="hidden sm:flex items-center gap-1.5 bg-black/[0.04] px-2 py-1 rounded-md border border-black/[0.05]">
          <button
            onClick={() => onSelectTab(activeTab === 'org' ? 'im' : 'org')}
            className={`flex items-center gap-1 text-[11.5px] px-2 py-0.5 rounded transition-colors cursor-pointer ${
              activeTab === 'org'
                ? 'bg-[#0099FF] text-white font-medium'
                : 'text-[#555558] hover:bg-black/[0.05]'
            }`}
            title="查看/管理 OPC 公司 HR 组织架构"
          >
            <Network className="w-3.5 h-3.5" />
            <span>
              HR组织架构 ({departmentCount}部门 · {agentCount}名Agent)
            </span>
          </button>
          <span className="text-[#CCCCCC] text-xs">|</span>
          <button
            onClick={onOpenHireModal}
            className="flex items-center gap-1 text-[11.5px] text-[#0077CC] hover:text-[#005FA3] font-medium px-1.5 py-0.5 rounded hover:bg-[#0099FF]/10 transition-colors cursor-pointer"
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>聘用Agent员工</span>
          </button>
        </div>

        {/* Exact Weather indicator from screenshot: ☁️ 阴 */}
        <div className="flex items-center gap-1.5 text-[#7C7C80] mr-1">
          <Cloud className="w-[18px] h-[18px] stroke-[1.6]" />
          <span className="text-[13.5px] text-[#555558]">阴</span>
        </div>

        {/* Exact Right Sidebar Toggle Icon from screenshot: [|<-] */}
        <button
          onClick={onToggleRightDrawer}
          className={`p-1 rounded hover:bg-black/5 transition-colors cursor-pointer ${
            rightDrawerOpen ? 'text-[#0099FF]' : 'text-[#4A4A4D]'
          }`}
          title="展开/收起 当前会话 Agent 员工档案与群组架构"
        >
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
            <rect
              x="2.2"
              y="3.5"
              width="15.6"
              height="13"
              rx="2.2"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <line x1="7.2" y1="3.5" x2="7.2" y2="16.5" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M13.2 8.2L10.8 10L13.2 11.8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
};
