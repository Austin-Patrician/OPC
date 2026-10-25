import { useState } from 'react';
import { Briefcase, FileText, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/entities/agent/model/types';
import type { Budget } from '@opc/shared/domain';
import type { Conversation, Department } from '@/entities/conversation/model/types';
import { Avatar } from '@/entities/agent/ui/Avatar';

interface AgentDossierDrawerProps {
  conversation: Conversation;
  members: readonly Agent[];
  department?: Department;
  onClose: () => void;
  onUpdateBrief: (agentId: string, briefMd: string) => void;
  budgetFor?: (employeeId: string) => Budget | undefined;
}

/**
 * 290px right drawer: department context, in-conversation roster, and the
 * per-agent `brief.md` that agents actually read before working.
 */
export function AgentDossierDrawer({
  conversation,
  members,
  department,
  onClose,
  onUpdateBrief,
  budgetFor,
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
        {department ? (
          <div className="rounded-xl border border-line bg-surface p-3 shadow-card">
            <div className="mb-1 flex items-center justify-between">
              <span className="font-mono text-xs text-ink-tertiary">{department.code}</span>
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: department.color }}
              />
            </div>
            <div className="text-base-plus font-semibold text-ink">{department.name}</div>
            <p className="mt-1 text-xs-plus leading-relaxed text-ink-tertiary">
              {department.description}
            </p>
          </div>
        ) : null}

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
                        <span className="rounded bg-accent/10 px-1.5 py-px font-mono text-3xs font-semibold text-accent-ink">
                          {agent.level}
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

                  {(() => {
                    const budget = budgetFor?.(agent.id);
                    if (!budget) return null;
                    const tone =
                      budget.state === 'stopped'
                        ? 'text-danger'
                        : budget.state === 'warn'
                          ? 'text-warning'
                          : 'text-ink-secondary';
                    return (
                      <div className={`flex items-center justify-between rounded bg-surface-muted px-2 py-1 text-xs ${tone}`}>
                        <span>{t('budget.employee')}</span>
                        <span className="font-mono">
                          {budget.usedTokens.toLocaleString()} / {budget.limitTokens.toLocaleString()}
                          <span className="ml-1 text-ink-quaternary">
                            · {t('budget.remaining', { tokens: budget.availableTokens.toLocaleString() })}
                          </span>
                        </span>
                      </div>
                    );
                  })()}

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
