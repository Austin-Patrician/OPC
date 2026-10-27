import React, { useEffect, useState, version as reactVersion } from 'react';
import { ArrowUpRight, BookOpen, FolderGit2, Package, RotateCcw, Sparkles } from 'lucide-react';
import { devDependencies, version as appVersion } from '../../../package.json';
import { onboardingStore } from '../onboarding/onboardingStore';
import {
  IMAGE_MODELS,
  PI_AGENT_DIR,
  PI_AI_PACKAGE,
  PI_AI_VERSION,
  PI_CHAT_PROVIDER_TOTAL,
  PI_NPM_URL,
  PI_REPO_URL,
  PI_SITE_URL,
} from './piCatalog';
import { STORAGE_KEY, settingsStore, useSettings } from './settingsStore';
import { CopyButton, KeyTag, Note, PageHeader, Section, buttonClass } from './settingsUi';

const LINKS = [
  { href: PI_REPO_URL, label: 'GitHub', sub: 'earendil-works/pi', icon: FolderGit2 },
  { href: PI_SITE_URL, label: '官网', sub: 'pi.dev', icon: BookOpen },
  { href: PI_NPM_URL, label: 'npm', sub: PI_AI_PACKAGE, icon: Package },
];

export const AboutSettings: React.FC = () => {
  const { persistent } = useSettings();
  const [confirming, setConfirming] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    if (!resetDone) return;
    const timer = window.setTimeout(() => setResetDone(false), 2400);
    return () => window.clearTimeout(timer);
  }, [resetDone]);

  const info: { label: string; value: string; note?: string }[] = [
    { label: '应用版本', value: appVersion, note: 'package.json' },
    { label: 'pi 模型目录', value: `${PI_AI_PACKAGE} ${PI_AI_VERSION}`, note: `${PI_CHAT_PROVIDER_TOTAL} 个对话 Provider · ${IMAGE_MODELS.length} 个图像模型` },
    { label: 'React', value: reactVersion, note: '运行时' },
    { label: 'Vite', value: devDependencies.vite, note: '声明版本' },
    { label: 'TypeScript', value: devDependencies.typescript, note: '声明版本' },
    { label: '构建模式', value: import.meta.env.MODE },
    { label: 'pi 配置目录', value: PI_AGENT_DIR, note: '可通过 PI_CODING_AGENT_DIR 覆盖' },
    { label: '偏好存储', value: STORAGE_KEY, note: persistent ? 'localStorage' : '不可用 · 仅本次有效' },
  ];
  const diagnostics = info.map((row) => `${row.label}: ${row.value}`).join('\n');

  const reset = () => {
    settingsStore.resetAll();
    setConfirming(false);
    setResetDone(true);
  };

  return (
    <>
      <PageHeader crumbs={['关于']} title="关于" />

      <div className="space-y-4">
        <section className="bg-white rounded-xl border border-[#E5E5E7] px-5 py-5 flex items-center gap-4">
          <div className="w-14 h-14 rounded-[16px] bg-gradient-to-br from-[#33ADFF] to-[#0077E6] flex items-center justify-center text-white text-[15px] font-bold tracking-tight shadow-[0_4px_12px_rgba(0,119,230,0.25)] shrink-0">
            OPC
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-[17px] font-bold text-[#1C1C1E]">OPC 一人公司</h3>
              <span className="h-5 px-1.5 rounded-md bg-[#F2F2F5] text-[11px] font-mono text-[#6E6E73] flex items-center">
                v{appVersion}
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-[#6E6E73]">AI Agent IM 协作平台 · Agent 运行时基于 pi</p>
          </div>
        </section>

        <Section title="版本信息" action={<CopyButton text={diagnostics} label="复制诊断信息" />}>
          <dl className="divide-y divide-[#F0F0F2]">
            {info.map((row) => (
              <div key={row.label} className="px-4 h-10 flex items-center gap-4">
                <dt className="w-[96px] shrink-0 text-[12.5px] text-[#6E6E73]">{row.label}</dt>
                <dd className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-[12.5px] font-mono text-[#1C1C1E] truncate select-text">{row.value}</span>
                  {row.note && <span className="text-[11px] text-[#AEAEB2] truncate">{row.note}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="pi 项目" description="Provider、模型目录与认证流程均以 pi 官方实现为准。">
          <div className="p-3 grid grid-cols-3 gap-2">
            {LINKS.map(({ href, label, sub, icon: Icon }) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="group rounded-lg border border-[#E5E5E7] px-3 py-2.5 flex items-center gap-2.5 hover:border-[#C7C7CC] hover:bg-[#FAFAFB] transition-colors"
              >
                <span className="w-8 h-8 rounded-lg bg-[#F2F2F5] flex items-center justify-center text-[#3A3A3C] shrink-0">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-[12.5px] font-medium text-[#1C1C1E]">{label}</span>
                  <span className="block text-[11px] font-mono text-[#8E8E93] truncate">{sub}</span>
                </span>
                <ArrowUpRight className="w-3.5 h-3.5 text-[#AEAEB2] group-hover:text-[#0077CC] shrink-0" />
              </a>
            ))}
          </div>
        </Section>

        <Section title="重置">
          <div className="px-4 py-3.5 flex items-center gap-6 border-b border-[#F0F0F2]">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[#1C1C1E]">新手引导</div>
              <div className="mt-0.5 text-[11.5px] text-[#8E8E93] leading-relaxed">
                重新浏览欢迎页并逐步调整偏好、模型、公司信息与团队；已有会话和员工不会被清除。
              </div>
            </div>
            <button type="button" className={`${buttonClass.secondary} shrink-0`} onClick={() => onboardingStore.reopen()}>
              <Sparkles className="w-3.5 h-3.5" />
              重新打开引导
            </button>
          </div>
          <div className="px-4 py-3.5 flex items-center gap-6">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-[#1C1C1E]">恢复默认设置</div>
              <div className="mt-0.5 text-[11.5px] text-[#8E8E93] leading-relaxed">
                恢复本页面的全部偏好并清除内存中的密钥；不会影响会话、组织架构等应用数据，也不会改动 pi 的{' '}
                <KeyTag>auth.json</KeyTag>。
              </div>
            </div>
            {confirming ? (
              <div className="flex items-center gap-2 shrink-0">
                <button type="button" className={buttonClass.secondary} onClick={() => setConfirming(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className={`${buttonClass.danger} !bg-[#D93025] !border-[#D93025] !text-white hover:!bg-[#C4291F]`}
                  onClick={reset}
                  autoFocus
                >
                  确认重置
                </button>
              </div>
            ) : (
              <button type="button" className={`${buttonClass.danger} shrink-0`} onClick={() => setConfirming(true)}>
                <RotateCcw className="w-3.5 h-3.5" />
                重置
              </button>
            )}
          </div>
          {resetDone && (
            <div className="px-4 pb-3.5">
              <Note>已恢复默认设置。</Note>
            </div>
          )}
        </Section>
      </div>
    </>
  );
};
