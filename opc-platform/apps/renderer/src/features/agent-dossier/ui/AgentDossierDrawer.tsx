import { useState } from 'react';
import { Briefcase, FileText, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/entities/agent/model/types';
import type { Conversation } from '@/entities/conversation/model/types';
import { Avatar } from '@/entities/agent/ui/Avatar';

interface AgentDossierDrawerProps {
  conversation: Conversation;
  members: readonly Agent[];
  onClose: () => void;
  onUpdateBrief: (agentId: string, briefMd: string) => void;
}

/**
 * 右侧 290px 抽屉：这次对话里有哪些执行体、用什么模型、花了多少，以及
 * 他们各自的工作说明（`brief.md`，执行前真的会读）。
 *
 * 这里曾经还有一块「部门」——部门在 B2 就删了，块里永远是空白，所以也拿掉了。
 */
export function AgentDossierDrawer({
  conversation,
  members,
  onClose,
  onUpdateBrief,
}: AgentDossierDrawerProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <aside className="hidden w-drawer shrink-0 flex-col overflow-y-auto border-l border-line bg-sidebar select-none surface-blur lg:flex">
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-1.5 text-base-plus font-semibold text-ink">
          <Briefcase className="size-4 text-accent" aria-hidden />
          <span>{conversation.kind === 'group' ? t('chat.dossierGroup') : t('chat.dossier')}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-ink-tertiary hover:text-ink"
        >
          {t('chat.collapse')}
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-secondary">
              {t('chat.currentAgents', { count: members.length })}
            </span>
            <span className="flex items-center gap-0.5 text-xs-plus text-accent-ink">
              <UserPlus className="size-3" aria-hidden />
              {t('chat.addAgent')}
            </span>
          </div>

          {members.length === 0 ? (
            <p className="text-sm text-ink-quaternary">{t('chat.noAgents')}</p>
          ) : null}

          <div className="space-y-2">
            {members.map((agent) => {
              const editing = editingId === agent.id;
              return (
                <div
                  key={agent.id}
                  className="space-y-2 rounded-xl border border-line bg-surface p-3 shadow-card"
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar name={agent.name} src={agent.avatarUrl} size="sm" status={agent.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-base font-semibold text-ink">
                          {agent.name}
                        </span>
                      </div>
                      <div className="truncate text-xs text-ink-tertiary">{agent.role}</div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded bg-surface-muted px-2 py-1 text-xs text-ink-secondary">
                    <span className="truncate">
                      {t('chat.model')}: {agent.model}
                    </span>
                  </div>


                  <div className="flex flex-wrap gap-1">
                    {agent.skills.map((skill) => (
                      <span
                        key={skill}
                        className="rounded bg-surface-muted px-1.5 py-0.5 text-3xs text-ink-secondary"
                      >
                        {skill}
                      </span>
                    ))}
                  </div>

                  <div className="border-t border-line pt-1">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="flex items-center gap-1 font-mono text-xs font-semibold text-ink-secondary">
                        <FileText className="size-3 text-accent" aria-hidden />
                        {t('chat.brief')}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          if (editing) {
                            onUpdateBrief(agent.id, draft);
                            setEditingId(null);
                            return;
                          }
                          setEditingId(agent.id);
                          setDraft(agent.briefMd);
                        }}
                        className="text-xs font-semibold text-accent-ink"
                      >
                        {editing ? t('common.save') : t('common.edit')}
                      </button>
                    </div>

                    {editing ? (
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={6}
                        className="w-full rounded border border-accent bg-surface p-1.5 font-mono text-xs text-ink outline-none select-text"
                      />
                    ) : (
                      <pre className="overflow-x-auto rounded bg-surface-muted p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
                        {agent.briefMd}
                      </pre>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
}
