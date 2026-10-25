import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, HardDrive } from 'lucide-react';
import { AboutSettings } from './AboutSettings';
import { AppearanceSettings, NetworkSettings, NotificationSettings, WorkspaceSettings } from './GeneralSettings';
import { ImageSettings } from './ImageSettings';
import { LlmSettings } from './LlmSettings';
import { SelfCheckRun, SelfCheckSettings } from './SelfCheckSettings';
import { SETTINGS_GROUPS, SettingsGroup, SettingsGroupId, SettingsPageId, groupOfPage } from './settingsNav';
import { useSettings } from './settingsStore';

export const SettingsView: React.FC = () => {
  const { persistent, savedAt, prefs } = useSettings();
  const [page, setPage] = useState<SettingsPageId>('appearance');
  const [expanded, setExpanded] = useState<Record<SettingsGroupId, boolean>>({
    general: true,
    models: true,
    selfcheck: false,
    about: false,
  });
  const [llmFocus, setLlmFocus] = useState<string>();
  // Lifted here so results survive switching between settings pages.
  const [checkRun, setCheckRun] = useState<SelfCheckRun | null>(null);
  const scrollRef = useRef<HTMLElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [page]);

  const activeGroup = groupOfPage(page);

  const navigate = (next: SettingsPageId, focusProviderId?: string) => {
    setLlmFocus(focusProviderId);
    setPage(next);
    const group = groupOfPage(next);
    if (group.pages.length > 1) setExpanded((e) => ({ ...e, [group.id]: true }));
  };

  const onGroupClick = (group: SettingsGroup) => {
    if (group.pages.length > 1 && group.id === activeGroup.id) {
      setExpanded((e) => ({ ...e, [group.id]: !e[group.id] }));
      return;
    }
    navigate(group.pages[0].id);
  };

  const issueCount = checkRun?.items.filter((i) => i.state === 'warn' || i.state === 'fail').length ?? 0;
  const savedTime = savedAt
    ? new Date(savedAt).toLocaleTimeString(prefs.language, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: prefs.timeFormat === '12h',
      })
    : '';

  const content = (() => {
    switch (page) {
      case 'appearance':
        return <AppearanceSettings />;
      case 'notifications':
        return <NotificationSettings />;
      case 'workspace':
        return <WorkspaceSettings />;
      case 'network':
        return <NetworkSettings />;
      case 'llm':
        return <LlmSettings initialProviderId={llmFocus} />;
      case 'image':
        return <ImageSettings onOpenLlmProvider={(id) => navigate('llm', id)} />;
      case 'selfcheck':
        return <SelfCheckSettings run={checkRun} onRunComplete={setCheckRun} onNavigate={navigate} />;
      case 'about':
        return <AboutSettings />;
    }
  })();

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-[#F2F2F3] select-none">
      <aside className="w-[220px] shrink-0 flex flex-col min-h-0 bg-[#F9F9FA] border-r border-[#E6E6E8]">
        <div className="px-4 pt-4 pb-3 shrink-0">
          <h1 className="text-[16px] font-bold text-[#1C1C1E] tracking-tight">设置</h1>
          <p className="mt-0.5 text-[11.5px] text-[#8E8E93]">偏好、模型与运行状态</p>
        </div>

        <nav aria-label="设置导航" className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          {SETTINGS_GROUPS.map((group) => {
            const Icon = group.icon;
            const hasSubmenu = group.pages.length > 1;
            const inGroup = group.id === activeGroup.id;
            const open = hasSubmenu && expanded[group.id];
            return (
              <div key={group.id}>
                <button
                  type="button"
                  onClick={() => onGroupClick(group)}
                  aria-expanded={hasSubmenu ? open : undefined}
                  aria-current={!hasSubmenu && inGroup ? 'page' : undefined}
                  className={`w-full h-8 px-2 rounded-md flex items-center gap-2.5 text-[13px] cursor-pointer transition-colors ${
                    !hasSubmenu && inGroup
                      ? 'bg-[#E4E4E8] text-[#1C1C1E] font-medium'
                      : inGroup
                        ? 'text-[#1C1C1E] font-medium hover:bg-black/[0.04]'
                        : 'text-[#3A3A3C] hover:bg-black/[0.04]'
                  }`}
                >
                  <span
                    className="w-5 h-5 rounded-[6px] flex items-center justify-center text-white shrink-0"
                    style={{ background: group.color }}
                  >
                    <Icon className="w-3 h-3" strokeWidth={2.2} />
                  </span>
                  <span className="flex-1 text-left">{group.label}</span>
                  {group.id === 'selfcheck' && issueCount > 0 && (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-[#F5A623] text-white text-[10.5px] font-semibold flex items-center justify-center tabular-nums">
                      {issueCount}
                    </span>
                  )}
                  {hasSubmenu && (
                    <ChevronRight
                      className={`w-3.5 h-3.5 text-[#AEAEB2] transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                  )}
                </button>
                {open && (
                  <div className="ml-[17px] pl-2.5 mt-0.5 mb-1.5 border-l border-[#E2E2E6] space-y-px">
                    {group.pages.map((p) => {
                      const active = p.id === page;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => navigate(p.id)}
                          aria-current={active ? 'page' : undefined}
                          className={`w-full h-7 px-2 rounded-md flex items-center text-[12.5px] cursor-pointer transition-colors ${
                            active
                              ? 'bg-[#E4E4E8] text-[#1C1C1E] font-medium'
                              : 'text-[#545458] hover:bg-black/[0.04] hover:text-[#1C1C1E]'
                          }`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="px-4 py-3 border-t border-[#ECECEE] flex items-center gap-2 text-[11px] text-[#8E8E93] shrink-0">
          <HardDrive className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">
            {!persistent
              ? '本机存储不可用，设置仅本次有效'
              : savedTime
                ? `已自动保存 · ${savedTime}`
                : '修改后自动保存到本机'}
          </span>
        </div>
      </aside>

      <main ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[880px] mx-auto px-8 pt-6 pb-10">{content}</div>
      </main>
    </div>
  );
};
