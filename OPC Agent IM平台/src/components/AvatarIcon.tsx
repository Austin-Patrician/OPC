import React from 'react';
import { Mail, Smartphone } from 'lucide-react';
import { AgentEmployee } from '../types/im';

interface AvatarIconProps {
  type?: AgentEmployee['avatarType'];
  avatarUrl?: string;
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  showOnlineBadge?: boolean;
  showTopBarBadge?: boolean;
  className?: string;
}

const sizeMap = {
  xs: 'w-6 h-6 text-[10px]',
  sm: 'w-8 h-8 text-xs',
  md: 'w-[42px] h-[42px] text-sm',
  lg: 'w-12 h-12 text-base',
  xl: 'w-14 h-14 text-lg',
};

export const AvatarIcon: React.FC<AvatarIconProps> = ({
  type = 'custom',
  avatarUrl,
  name = 'Agent',
  size = 'md',
  showOnlineBadge = false,
  showTopBarBadge = false,
  className = '',
}) => {
  const dim = sizeMap[size];

  const renderInner = () => {
    switch (type) {
      case 'founder-girl':
        // Cute chibi red/brown hair anime character avatar matching the top bar & right-side user bubbles
        return (
          <div className="w-full h-full rounded-full bg-[#F7F1E5] flex items-center justify-center overflow-hidden relative border border-black/5">
            <svg viewBox="0 0 64 64" className="w-full h-full">
              <circle cx="32" cy="32" r="32" fill="#F8F2E6" />
              {/* Hair back */}
              <path d="M16 28 C14 16, 50 16, 48 28 C50 38, 46 44, 42 44 L22 44 C18 44, 14 38, 16 28Z" fill="#7C2D12" />
              {/* Cute bow / hairband */}
              <circle cx="20" cy="20" r="4.5" fill="#EF4444" />
              <circle cx="44" cy="20" r="4.5" fill="#F59E0B" />
              {/* Face */}
              <ellipse cx="32" cy="33" rx="11.5" ry="10.5" fill="#FFE4D6" />
              {/* Bangs */}
              <path d="M20 26 C23 20, 41 20, 44 26 C40 24, 36 28, 32 25 C28 28, 24 24, 20 26Z" fill="#881B1B" />
              {/* Eyes */}
              <ellipse cx="27.5" cy="33.5" rx="2" ry="2.4" fill="#291D1E" />
              <ellipse cx="36.5" cy="33.5" rx="2" ry="2.4" fill="#291D1E" />
              <circle cx="27" cy="32.7" r="0.7" fill="#FFFFFF" />
              <circle cx="36" cy="32.7" r="0.7" fill="#FFFFFF" />
              {/* Blush */}
              <ellipse cx="24.5" cy="36.5" rx="2.2" ry="1.1" fill="#FCA5A5" opacity="0.75" />
              <ellipse cx="39.5" cy="36.5" rx="2.2" ry="1.1" fill="#FCA5A5" opacity="0.75" />
              {/* Outfit */}
              <path d="M24 43 L40 43 L43 56 L21 56 Z" fill="#EAB308" />
              <path d="M27 43 L37 43 L35 51 L29 51 Z" fill="#EF4444" />
            </svg>
          </div>
        );

      case 'avalonia':
        return (
          <div className="w-full h-full rounded-full bg-[#1B6EC2] flex items-center justify-center text-white font-bold select-none shadow-xs">
            <svg viewBox="0 0 40 40" className="w-full h-full">
              <circle cx="20" cy="20" r="19" fill="#1B6EC2" />
              <circle cx="20" cy="20" r="10.5" fill="none" stroke="#FFFFFF" strokeWidth="4.2" />
              <rect x="26.5" y="19" width="4.2" height="11.5" rx="2" fill="#FFFFFF" />
              <circle cx="20" cy="20" r="3.2" fill="#FFFFFF" />
            </svg>
          </div>
        );

      case 'dotnet':
        return (
          <div className="w-full h-full rounded-full bg-[#512BD4] flex items-center justify-center text-white font-semibold tracking-tight select-none">
            <span className="text-[12px] font-bold leading-none">.NET</span>
          </div>
        );

      case 'cat':
        return (
          <div className="w-full h-full rounded-full bg-[#D7D3CE] overflow-hidden relative">
            <img
              src="https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=120&h=120&fit=crop&auto=format"
              alt="薅羊毛情报局"
              className="w-full h-full object-cover"
            />
          </div>
        );

      case 'flower':
        return (
          <div className="w-full h-full rounded-full bg-[#2E4230] overflow-hidden relative">
            <img
              src="https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=120&h=120&fit=crop&auto=format"
              alt="洛阳理工广东老乡会"
              className="w-full h-full object-cover"
            />
          </div>
        );

      case 'shark':
        return (
          <div className="w-full h-full rounded-full bg-[#111827] flex flex-col items-center justify-center overflow-hidden relative border border-slate-700">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-900/80 via-slate-900 to-red-900/80" />
            <span className="relative z-10 text-[9px] font-black text-cyan-300 leading-tight tracking-tighter drop-shadow">
              鲨鱼
            </span>
            <span className="relative z-10 text-[9px] font-black text-rose-400 leading-tight tracking-tighter drop-shadow">
              辣椒
            </span>
          </div>
        );

      case 'dark-blur':
        // Moody dark atmospheric portrait matching "殇丶泪" in the screenshot
        return (
          <div className="w-full h-full rounded-full bg-[#26292E] overflow-hidden relative flex items-center justify-center">
            <svg viewBox="0 0 60 60" className="w-full h-full">
              <defs>
                <radialGradient id="darkMood" cx="55%" cy="40%" r="60%">
                  <stop offset="0%" stopColor="#6C737A" />
                  <stop offset="55%" stopColor="#35393E" />
                  <stop offset="100%" stopColor="#181A1D" />
                </radialGradient>
              </defs>
              <circle cx="30" cy="30" r="30" fill="url(#darkMood)" />
              <ellipse cx="33" cy="27" rx="12" ry="14" fill="#8A929A" opacity="0.35" />
              <path d="M12 18 Q28 30 48 16 Q38 8 20 10 Z" fill="#141619" opacity="0.82" />
              <path d="M10 46 Q30 34 52 48 L52 60 L10 60 Z" fill="#1F2327" opacity="0.9" />
            </svg>
          </div>
        );

      case 'mail':
        return (
          <div className="w-full h-full rounded-full bg-[#2B85F5] flex items-center justify-center text-white">
            <Mail className="w-5 h-5 stroke-[2]" />
          </div>
        );

      case 'user-silhouette':
        return (
          <div className="w-full h-full rounded-full bg-[#E1EEFA] flex items-center justify-center overflow-hidden">
            <svg viewBox="0 0 48 48" className="w-full h-full">
              <circle cx="24" cy="24" r="24" fill="#E1EFFA" />
              <circle cx="24" cy="18" r="7.5" fill="#465362" />
              <path d="M11 42 C11 32, 37 32, 37 42 Z" fill="#465362" />
            </svg>
          </div>
        );

      case 'capybara':
        return (
          <div className="w-full h-full rounded-full bg-[#B59E7A] overflow-hidden relative">
            <img
              src="https://images.unsplash.com/photo-1548767797-d8c844163c4c?w=120&h=120&fit=crop&auto=format"
              alt="kk与小伙伴们4"
              className="w-full h-full object-cover"
            />
          </div>
        );

      case 'phone':
        return (
          <div className="w-full h-full rounded-full bg-[#2680EB] flex items-center justify-center text-white">
            <Smartphone className="w-5 h-5 stroke-[2]" />
          </div>
        );

      default:
        if (avatarUrl) {
          return (
            <div className="w-full h-full rounded-full bg-slate-200 overflow-hidden relative">
              <img src={avatarUrl} alt={name} className="w-full h-full object-cover" />
            </div>
          );
        }
        return (
          <div className="w-full h-full rounded-full bg-gradient-to-br from-[#0099FF] to-[#1D4ED8] flex items-center justify-center text-white font-semibold">
            {name.slice(0, 1)}
          </div>
        );
    }
  };

  return (
    <div className={`relative inline-flex shrink-0 ${dim} ${className}`}>
      {renderInner()}
      {showTopBarBadge && (
        <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#F5A623] border border-[#EBEBEC] flex items-center justify-center">
          <span className="w-1.5 h-[1.5px] bg-white rounded-full" />
        </span>
      )}
      {showOnlineBadge && (
        <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#27C93F] ring-2 ring-white" />
      )}
    </div>
  );
};
