import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight, Loader2, MessageSquare, Plus, Users } from 'lucide-react';
import type { DepartmentNode } from '@opc/shared/domain';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { cn } from '@/shared/lib/cn';

type Step = 'menu' | 'direct' | 'group';

/**
 * The `+` next to the boss avatar: the one place that starts new work.
 *
 * Both actions resolve to a real conversation before navigating, so the chat page
 * never has to guess what "new" means. The data is fetched on open rather than
 * cached, because a freshly hired agent must be selectable immediately.
 */
export function StartMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('menu');
  const [departments, setDepartments] = useState<DepartmentNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const load = async () => {
    try {
      const list = await window.opc!.org.list();
      setDepartments(list);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const toggle = () => {
    setOpen((value) => {
      if (value) return false;
      setStep('menu');
      setError(null);
      setDepartments(null);
      void load();
      return true;
    });
  };

  const startDirect = async (employeeId: string) => {
    if (busyId) return;
    setBusyId(employeeId);
    try {
      const conversationId = await window.opc!.chat.openDirect(employeeId);
      setOpen(false);
      navigate(`/chat/${conversationId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  const startGroup = async (departmentId: string) => {
    if (busyId) return;
    setBusyId(departmentId);
    try {
      const conversationId = await window.opc!.chat.ensureDepartmentGroup(departmentId);
      setOpen(false);
      navigate(`/chat/${conversationId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  };

  const members = (departments ?? [])
    .flatMap((department) => department.members)
    .filter((member) => member.status === 'active')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  const groups = (departments ?? [])
    .map((department) => ({
      department,
      active: department.members.filter((member) => member.status === 'active').length,
    }))
    .filter((entry) => entry.active > 0)
    .sort((a, b) => a.department.name.localeCompare(b.department.name, 'zh-Hans-CN'));

  const loading = departments === null && !error;

  const entryClass =
    'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-hover disabled:opacity-60';

  return (
    <div ref={rootRef} className="no-drag relative">
      <button
        type="button"
        data-testid="start-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('titleBar.start')}
        title={t('titleBar.start')}
        onClick={toggle}
        className={cn(
          'flex size-7 items-center justify-center rounded-full border transition-colors',
          open
            ? 'border-accent bg-accent-soft text-accent-ink'
            : 'border-line bg-surface text-ink-secondary hover:border-accent hover:text-accent',
        )}
      >
        <Plus className="size-4" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          data-testid="start-menu"
          aria-label={t('titleBar.start')}
          className="absolute top-full left-0 z-50 mt-2 w-64 cursor-default rounded-xl border border-line bg-surface p-1.5 shadow-popover"
        >
          {step === 'menu' ? (
            <div className="space-y-0.5">
              <button
                type="button"
                role="menuitem"
                data-testid="start-direct"
                onClick={() => setStep('direct')}
                className={entryClass}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
                  <MessageSquare className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">{t('titleBar.startDirect')}</span>
                  <span className="block truncate text-3xs text-ink-quaternary">
                    {t('titleBar.startDirectHint')}
                  </span>
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-ink-quaternary" aria-hidden />
              </button>

              <button
                type="button"
                role="menuitem"
                data-testid="start-group"
                onClick={() => setStep('group')}
                className={entryClass}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-secondary">
                  <Users className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium text-ink">{t('titleBar.startGroup')}</span>
                  <span className="block truncate text-3xs text-ink-quaternary">
                    {t('titleBar.startGroupHint')}
                  </span>
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-ink-quaternary" aria-hidden />
              </button>
            </div>
          ) : (
            <>
              <div className="mb-1 flex items-center gap-1 px-0.5">
                <button
                  type="button"
                  aria-label={t('titleBar.startBack')}
                  onClick={() => setStep('menu')}
                  className="flex size-6 items-center justify-center rounded-md text-ink-tertiary transition-colors hover:bg-surface-hover hover:text-ink"
                >
                  <ArrowLeft className="size-3.5" aria-hidden />
                </button>
                <span className="text-2xs font-medium text-ink-secondary">
                  {step === 'direct' ? t('titleBar.pickAgent') : t('titleBar.pickDepartment')}
                </span>
              </div>

              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {loading ? (
                  <p className="flex items-center gap-1.5 px-2 py-2 text-3xs text-ink-quaternary">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    {t('common.loading')}
                  </p>
                ) : step === 'direct' ? (
                  members.length === 0 ? (
                    <p className="px-2 py-2 text-3xs text-ink-quaternary">{t('titleBar.startNoAgents')}</p>
                  ) : (
                    members.map((member) => (
                      <button
                        key={member.id}
                        type="button"
                        data-testid="start-direct-option"
                        disabled={busyId !== null}
                        onClick={() => void startDirect(member.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
                      >
                        <Avatar name={member.name} src={member.avatar} size="xs" className="size-6" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-ink">{member.name}</span>
                          <span className="block truncate text-3xs text-ink-quaternary">
                            {member.title || member.role}
                          </span>
                        </span>
                        {busyId === member.id ? (
                          <Loader2 className="size-3 animate-spin text-ink-tertiary" aria-hidden />
                        ) : null}
                      </button>
                    ))
                  )
                ) : groups.length === 0 ? (
                  <p className="px-2 py-2 text-3xs text-ink-quaternary">{t('titleBar.startNoDepartments')}</p>
                ) : (
                  groups.map(({ department, active }) => (
                    <button
                      key={department.id}
                      type="button"
                      data-testid="start-group-option"
                      disabled={busyId !== null}
                      onClick={() => void startGroup(department.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover disabled:opacity-60"
                    >
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-[3px]"
                        style={{ background: department.color }}
                      />
                      <span className="min-w-0 flex-1 truncate text-xs text-ink">{department.name}</span>
                      <span className="font-mono text-3xs text-ink-quaternary">{active}</span>
                      {busyId === department.id ? (
                        <Loader2 className="size-3 animate-spin text-ink-tertiary" aria-hidden />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </>
          )}

          {error ? <p className="mt-1 px-2 pb-1 text-3xs text-danger">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}