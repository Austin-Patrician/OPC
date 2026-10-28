import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  BadgeCheck,
  Building2,
  ChevronRight,
  Cpu,
  MessageSquare,
  Crown,
  LayoutGrid,
  Move,
  List,
  Network,
  PanelLeft,
  PackagePlus,
  Plus,
  Search,
  UserPlus,
  UserCog,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  DepartmentEditInput,
  DepartmentNode,
  EmploymentEvent,
  Evaluation,
  JobNode,
  OrgMember,
  PersonnelInput,
} from '@opc/shared/domain';
import type { OrgFactView } from '@opc/shared/ipc';
import { Avatar } from '@/entities/agent/ui/Avatar';
import { HireWizard } from './HireWizard';
import { cn } from '@/shared/lib/cn';
import { buttonClass, TextField } from '@/features/settings/ui/kit';

type OrgView = 'tree' | 'board' | 'roster' | 'badge';
type StatusFilter = 'all' | 'active' | 'terminated';

const VIEW_KEY = 'opc.org.view';
const LINE = 'var(--border-strong)';

const VIEWS: { id: OrgView; icon: typeof Network; labelKey: string }[] = [
  { id: 'tree', icon: Network, labelKey: 'org.view.tree' },
  { id: 'board', icon: LayoutGrid, labelKey: 'org.view.board' },
  { id: 'roster', icon: List, labelKey: 'org.view.roster' },
  { id: 'badge', icon: BadgeCheck, labelKey: 'org.view.badge' },
];

/** Children of `parentId` (undefined = top level), already in chart order. */
function childrenOf(departments: DepartmentNode[], parentId?: string): DepartmentNode[] {
  return departments.filter((node) => (node.parentId ?? '') === (parentId ?? ''));
}

/** A department and everything under it: what "focus this department" means. */
function subtreeIds(departments: DepartmentNode[], rootId: string): Set<string> {
  const ids = new Set<string>();
  const walk = (id: string) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of childrenOf(departments, id)) walk(child.id);
  };
  walk(rootId);
  return ids;
}

/** Root → … → the department itself, for the breadcrumb. */
function ancestorsOf(departments: DepartmentNode[], id: string): DepartmentNode[] {
  const byId = new Map(departments.map((node) => [node.id, node]));
  const chain: DepartmentNode[] = [];
  const seen = new Set<string>();
  let cursor = byId.get(id);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}

/** Pre-order walk, so the directory can render a tree as a flat indented list. */
function flattenTree(departments: DepartmentNode[]): { node: DepartmentNode; depth: number }[] {
  const rows: { node: DepartmentNode; depth: number }[] = [];
  const walk = (parentId: string | undefined, depth: number) => {
    for (const node of childrenOf(departments, parentId)) {
      rows.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return rows;
}

/**
 * The one human in this company.
 *
 * Read from the company profile (which reads the single `app_user` row) rather than
 * hard-coding a label: the org chart's root card is a person, and it should show the
 * name and portrait the boss actually set. Falls back to the translated default while
 * the IPC call is in flight, so the card never renders empty.
 */
function useBossIdentity(): { name: string; avatar?: string } {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<{ name: string; avatar?: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.opc?.company
      .get()
      .then((next) => {
        if (alive) {
          setProfile({
            name: next.bossName,
            ...(next.bossAvatar ? { avatar: next.bossAvatar } : {}),
          });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return profile ?? { name: t('org.founder') };
}

/**
 * Org chart, aligned with the design:
 *   directory (232, tree + headcount card) → toolbar (4 views, filters, zoom)
 *   → tree canvas with connector bus / board / roster / badges → detail (336).
 */
export function OrgPage() {
  const { t } = useTranslation();
  const [departments, setDepartments] = useState<DepartmentNode[]>([]);
  const [scopeId, setScopeId] = useState('');
  const [memberId, setMemberId] = useState('');
  const [view, setView] = useState<OrgView>(() => (localStorage.getItem(VIEW_KEY) as OrgView) || 'tree');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [hireFor, setHireFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedMembers, setCollapsedMembers] = useState<Set<string>>(new Set());
  const [deptId, setDeptId] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [newDeptOpen, setNewDeptOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [jobs, setJobs] = useState<JobNode[]>([]);
  const boss = useBossIdentity();

  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);

  const load = async () => {
    const list = await window.opc!.org.list();
    setDepartments(list);
    setScopeId((current) => (current === '' ? '' : list.some((n) => n.id === current) ? current : ''));
    // Jobs are only needed by the hire wizard and the department panel; loading them
    // with the chart keeps "which slots are open" from being a stale second fetch.
    try {
      setJobs(await window.opc!.org.jobs());
    } catch {
      setJobs([]);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const membersById = useMemo(
    () => new Map(departments.flatMap((node) => node.members).map((member) => [member.id, member])),
    [departments],
  );
  const allMembers = departments.flatMap((node) => node.members);
  const totalMembers = allMembers.length;

  const needle = query.trim().toLowerCase();
  const keep = (member: OrgMember) =>
    (status === 'all' || member.status === status) &&
    (!needle ||
      member.name.toLowerCase().includes(needle) ||
      member.title.toLowerCase().includes(needle) ||
      member.role.toLowerCase().includes(needle));

  const filtered = departments.map((node) => ({ ...node, members: node.members.filter(keep) }));
  // Focusing a department means focusing its whole subtree: a division that shows
  // only its own empty seat is not what "看这个部门" means.
  const scopeIds = useMemo(
    () => (scopeId ? subtreeIds(departments, scopeId) : undefined),
    [departments, scopeId],
  );
  const visible = scopeIds ? filtered.filter((node) => scopeIds.has(node.id)) : filtered;
  const scopeChain = scopeId ? ancestorsOf(departments, scopeId) : [];

  const selectedMember = memberId ? membersById.get(memberId) : undefined;
  const selectedDepartment = deptId ? departments.find((node) => node.id === deptId) : undefined;

  const openChat = (conversationId: string) => {
    window.location.hash = `#/chat/${conversationId}`;
  };
  const startDirect = (employeeId: string) => {
    void window.opc!.chat.openDirect(employeeId).then(openChat);
  };
  const openDepartmentGroup = (departmentId: string) => {
    void window.opc!.chat.ensureDepartmentGroup(departmentId).then(openChat);
  };

  const openMember = (member: OrgMember) => {
    setDeptId('');
    setMemberId(member.id);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-panel">
      {/* Row 1 — the two HR modes plus the two creation actions */}
      <header className="flex h-[3.375rem] shrink-0 items-center justify-between border-b border-line bg-surface px-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-0.5 rounded-lg bg-surface-muted p-0.5">
            <button
              type="button"
              aria-pressed
              className="flex items-center gap-1.5 rounded-md bg-surface px-3 py-1 text-base-plus font-medium text-ink shadow-xs"
              data-testid="tab-org"
            >
              <Network className="size-3.5 text-accent" />
              <span>{t('org.tabOrg')} ({totalMembers}人)</span>
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.hash = '#/market';
              }}
              data-testid="tab-market"
              className="flex items-center gap-1.5 rounded-md px-3 py-1 text-base-plus font-medium text-ink-tertiary transition-colors hover:text-ink"
            >
              <UserPlus className="size-3.5 text-danger" />
              <span>{t('org.tabMarket')}</span>
            </button>
          </div>
          <span className="hidden text-xs text-ink-tertiary lg:inline">
            {t('org.directDepartments', { count: departments.length })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNewDeptOpen(true)}
            data-testid="new-department"
            className="flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 text-base-plus font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            <Building2 className="size-3.5 text-accent" />
            <span>{t('org.newDepartment')}</span>
          </button>
          <button
            type="button"
            onClick={() => setHireFor(scopeId || '')}
            data-testid="custom-hire"
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-base-plus font-medium text-white shadow-xs transition-colors hover:bg-accent-hover"
          >
            <UserPlus className="size-3.5" />
            <span>{t('org.customHire')}</span>
          </button>
        </div>
      </header>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-danger/5 px-4 py-1.5 text-xs text-danger">
          <span className="flex-1 truncate">{error}</span>
          <button type="button" aria-label={t('common.close')} onClick={() => setError(null)}>
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}
      {busy ? <span className="sr-only">loading</span> : null}

      <div className="relative flex min-h-0 flex-1">
        {directoryOpen ? (
          <Directory
            departments={departments}
            scopeId={scopeId}
            onScope={(id) => setScopeId(id)}
            onClose={() => setDirectoryOpen(false)}
            onCreate={() => setNewDeptOpen(true)}
          />
        ) : null}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Toolbar
            view={view}
            setView={setView}
            status={status}
            setStatus={setStatus}
            counts={{
              all: departments.reduce((sum, node) => sum + node.members.length, 0),
              active: departments.reduce(
                (sum, node) => sum + node.members.filter((member) => member.status === 'active').length,
                0,
              ),
              terminated: departments.reduce(
                (sum, node) => sum + node.members.filter((member) => member.status !== 'active').length,
                0,
              ),
            }}
            scopeChain={scopeChain}
            onScopeHome={() => setScopeId('')}
            onScope={(id) => setScopeId(id)}
            directoryOpen={directoryOpen}
            onShowDirectory={() => setDirectoryOpen(true)}
            query={query}
            setQuery={setQuery}
          />

          <div className="min-h-0 flex-1">
            {view === 'tree' ? (
              <TreeView
                departments={visible}
                boss={boss}
                zoom={zoom}
                collapsed={collapsed}
                onToggle={(id) =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
                onOpen={openMember}
                  onOpenDept={(id) => {
                  setMemberId('');
                  setDeptId(id);
                }}
                onZoom={{
                  zoom,
                  in: () => setZoom((value) => Math.min(1.4, Math.round((value + 0.1) * 10) / 10)),
                  out: () => setZoom((value) => Math.max(0.6, Math.round((value - 0.1) * 10) / 10)),
                  reset: () => setZoom(1),
                  step: (delta) =>
                    setZoom((value) => Math.min(1.4, Math.max(0.6, Math.round((value + delta) * 10) / 10))),
                }}
                activeMemberId={memberId}
                activeDeptId={deptId}
                totalMembers={totalMembers}
                onHire={(deptIdValue) => setHireFor(deptIdValue)}
                collapsedMembers={collapsedMembers}
                onToggleMember={(id) =>
                  setCollapsedMembers((previous) => {
                    const next = new Set(previous);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
            ) : null}
            {view === 'board' ? (
              <BoardView
                departments={filtered}
                scopeIds={scopeIds}
                onOpen={openMember}
                onOpenDept={(id) => {
                  setMemberId('');
                  setDeptId(id);
                }}
                onHire={(departmentId) => setHireFor(departmentId)}
                onTransfer={(employeeId, departmentId) =>
                  void act(() => window.opc!.org.personnel({ employeeId, action: 'transfer', departmentId }))
                }
                onStartDm={startDirect}
                onOpenDeptGroup={openDepartmentGroup}
                activeMemberId={memberId}
              />
            ) : null}
            {view === 'roster' ? (
              <RosterView departments={filtered} scopeIds={scopeIds} onOpen={openMember} membersById={membersById} />
            ) : null}
            {view === 'badge' ? (
              <BadgeView
                departments={filtered}
                scopeIds={scopeIds}
                onOpen={openMember}
                activeMemberId={memberId}
              />
            ) : null}
          </div>
        </div>

        {/* Only a click on the canvas opens this panel; the directory only filters. */}
        {selectedMember || selectedDepartment ? (
          <aside className="flex w-[21rem] shrink-0 flex-col border-l border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="flex items-center gap-1.5 text-base-plus font-semibold text-ink">
                {selectedDepartment ? (
                  <span
                    aria-hidden
                    className="size-2 rounded-[3px]"
                    style={{ background: selectedDepartment.color }}
                  />
                ) : null}
                {selectedMember
                  ? t('org.memberDetail')
                  : `${selectedDepartment!.name} · ${t('org.deptDetail')}`}
              </span>
              <button
                type="button"
                aria-label={t('common.close')}
                data-testid="close-detail"
                onClick={() => {
                  setMemberId('');
                  setDeptId('');
                }}
                className="text-ink-tertiary hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {selectedMember ? (
                <MemberDetail
                  member={selectedMember}
                  boss={boss}
                  manager={
                    selectedMember.reportsToEmployeeId
                      ? membersById.get(selectedMember.reportsToEmployeeId)
                      : undefined
                  }
                  reports={allMembers.filter(
                    (member) =>
                      member.reportsToEmployeeId === selectedMember.id && member.status === 'active',
                  )}
                  departments={departments}
                  onAvatar={(dataUrl) => void act(() => window.opc!.org.setAvatar(selectedMember.id, dataUrl))}
                  onPersonnel={(input) => void act(() => window.opc!.org.personnel(input))}
                  onStartDm={startDirect}
                  onOpenDeptGroup={openDepartmentGroup}
                />
              ) : (
                <DepartmentSummary
                  department={selectedDepartment}
                  departments={departments}
                  onHire={() => setHireFor(selectedDepartment!.id)}
                  onOpenGroup={() => openDepartmentGroup(selectedDepartment!.id)}
                  onOpenMember={openMember}
                  onUpdate={(input) => void act(() => window.opc!.org.updateDepartment(input))}
                  onAppointHead={(employeeId) =>
                    void act(() => window.opc!.org.appointHead(selectedDepartment!.id, employeeId))
                  }
                  onAppointActingHead={(employeeId) =>
                    void act(() => window.opc!.org.appointActingHead(selectedDepartment!.id, employeeId))
                  }
                  onArchive={() =>
                    void act(async () => {
                      await window.opc!.org.archiveDepartment(selectedDepartment!.id);
                      setDeptId('');
                    })
                  }
                />
              )}
            </div>
          </aside>
        ) : null}
      </div>

      {hireFor !== null ? (
        <HireWizard
          departments={departments}
          jobs={jobs}
          defaultDepartmentId={hireFor || scopeId}
          onClose={() => setHireFor(null)}
          onSubmit={async (input) => {
            await act(async () => {
              await window.opc!.org.hire(input);
              setHireFor(null);
            });
          }}
        />
      ) : null}

      {newDeptOpen ? (
        <NewDepartmentModal
          employees={allMembers.filter((member) => member.status === 'active')}
          departments={departments}
          defaultParentId={scopeId}
          onClose={() => setNewDeptOpen(false)}
          onSubmit={async (input) => {
            await act(async () => {
              await window.opc!.org.createDepartment(input);
            });
            setNewDeptOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Directory({
  departments,
  scopeId,
  onScope,
  onCreate,
  onClose,
}: {
  departments: DepartmentNode[];
  scopeId: string;
  onScope: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const total = departments.reduce((sum, node) => sum + node.members.length, 0);
  const rows = flattenTree(departments);
  const itemClass = (active: boolean) =>
    cn(
      'flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm-plus transition-colors',
      active ? 'bg-surface-active font-medium text-ink' : 'text-ink-secondary hover:bg-ink/5',
    );

  return (
    <aside className="flex w-[14.5rem] shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-11 shrink-0 items-center justify-between px-4">
        <span className="text-xs font-semibold text-ink-tertiary">{t('org.directory')}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label={t('org.newDepartment')}
            onClick={onCreate}
            className="flex size-6 items-center justify-center rounded-md text-ink-tertiary hover:bg-ink/5 hover:text-ink"
          >
            <Plus className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t('org.hideDirectory')}
            data-testid="hide-directory"
            onClick={onClose}
            className="flex size-6 items-center justify-center rounded-md text-ink-tertiary hover:bg-ink/5 hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <button type="button" data-testid="org-scope-all" onClick={() => onScope('')} className={itemClass(scopeId === '')}>
          <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent text-white">
            <Building2 className="size-3" />
          </span>
          <span className="flex-1 truncate text-left">{t('org.company')}</span>
          <span className="font-mono text-2xs text-ink-quaternary">{total}</span>
        </button>

        <div className="mt-0.5 ml-[1.0625rem] space-y-px border-l border-line pl-1.5">
          {rows.map(({ node, depth }) => (
            <button
              key={node.id || 'unassigned'}
              type="button"
              data-testid="org-department"
              onClick={() => onScope(node.id)}
              title={node.description}
              style={depth > 0 ? { paddingLeft: `${0.5 + depth * 0.6}rem` } : undefined}
              className={itemClass(scopeId === node.id)}
            >
              <span aria-hidden className="size-2 shrink-0 rounded-[3px]" style={{ background: node.color }} />
              <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
              <span className="font-mono text-2xs text-ink-quaternary">{node.members.length}</span>
            </button>
          ))}
        </div>
      </nav>

      <div className="shrink-0 border-t border-line p-3">
        <div className="rounded-xl border border-line bg-surface p-3">
          <div className="flex items-center justify-between text-2xs text-ink-tertiary">
            <span className="font-semibold">{t('org.headcount')}</span>
            <span className="font-mono">{departments.length} {t('org.departmentUnit')}</span>
          </div>
          <div className="mt-2 flex items-baseline gap-1">
            <span className="font-mono text-2xl leading-none font-bold text-ink">{total}</span>
            <span className="text-xs-plus text-ink-tertiary">{t('org.peopleActive')}</span>
          </div>

          <div className="mt-2.5 flex h-1.5 gap-px overflow-hidden rounded-full bg-surface-muted">
            {departments.map((node) =>
              node.members.length > 0 ? (
                <span
                  key={node.id || 'unassigned'}
                  title={`${node.name} · ${node.members.length}`}
                  style={{ flex: `${node.members.length} 1 0%`, background: node.color }}
                />
              ) : null,
            )}
          </div>

          <div className="mt-3 space-y-1.5">
            {(['active', 'terminated'] as const).map((key) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-ink-tertiary">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ background: key === 'active' ? 'var(--success)' : 'var(--danger)' }}
                  />
                  {key === 'active' ? t('org.active') : t('org.terminated')}
                </span>
                <span className="font-mono text-ink">
                  {departments.flatMap((node) => node.members).filter((member) => member.status === key).length}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function Toolbar({
  view,
  setView,
  status,
  setStatus,
  counts,
  scopeChain,
  onScopeHome,
  onScope,
  directoryOpen,
  onShowDirectory,
  query,
  setQuery,
}: {
  view: OrgView;
  setView: (view: OrgView) => void;
  status: StatusFilter;
  setStatus: (status: StatusFilter) => void;
  counts: { all: number; active: number; terminated: number };
  /** Root → focused department, so a nested department shows where it sits. */
  scopeChain: DepartmentNode[];
  onScopeHome: () => void;
  onScope: (departmentId: string) => void;
  directoryOpen: boolean;
  onShowDirectory: () => void;
  query: string;
  setQuery: (value: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <div role="tablist" aria-label={t('org.title')} className="flex shrink-0 rounded-lg bg-surface-muted p-0.5">
        {VIEWS.map(({ id, icon: Icon, labelKey }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              data-testid={`org-view-${id}`}
              aria-selected={active}
              onClick={() => setView(id)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm-plus font-medium transition-colors',
                active ? 'bg-surface text-ink shadow-card' : 'text-ink-tertiary hover:text-ink',
              )}
            >
              <Icon className={cn('size-3.5', active && 'text-accent')} />
              <span className="hidden md:inline">{t(labelKey)}</span>
            </button>
          );
        })}
      </div>

      <span className="h-5 w-px shrink-0 bg-line" />

      <div className="flex min-w-0 items-center gap-1 text-sm">
        <button
          type="button"
          onClick={onScopeHome}
          className={cn('shrink-0', scopeChain.length > 0 ? 'text-ink-tertiary hover:text-ink' : 'font-medium text-ink')}
        >
          {t('org.company')}
        </button>
        {scopeChain.map((node, index) => (
          <span key={node.id} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="size-3 shrink-0 text-ink-quaternary" />
            <button
              type="button"
              onClick={() => onScope(node.id)}
              className={cn(
                'truncate',
                index === scopeChain.length - 1 ? 'font-medium text-ink' : 'text-ink-tertiary hover:text-ink',
              )}
            >
              {node.name}
            </button>
          </span>
        ))}
      </div>

      <div className="relative ml-1 w-40">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-quaternary" />
        <TextField
          ariaLabel={t('common.search')}
          value={query}
          onChange={setQuery}
          placeholder={t('common.search')}
          className="h-7 pl-7 text-sm"
        />
      </div>

      <div
        data-testid="org-status-filter"
        className="ml-1 flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-muted p-0.5"
      >
        {(
          [
            ['all', t('org.statusAll'), counts.all],
            ['active', t('org.active'), counts.active],
            ['terminated', t('org.terminated'), counts.terminated],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={status === key}
            onClick={() => setStatus(key)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors',
              status === key ? 'bg-surface font-medium text-ink shadow-card' : 'text-ink-tertiary hover:text-ink',
            )}
          >
            {label}
            <span className="font-mono text-2xs text-ink-quaternary">{count}</span>
          </button>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {directoryOpen ? null : (
          <button
            type="button"
            aria-label={t('org.showDirectory')}
            data-testid="show-directory"
            onClick={onShowDirectory}
            className="flex size-6 items-center justify-center rounded-md text-ink-tertiary hover:bg-ink/5 hover:text-ink"
          >
            <PanelLeft className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Canvas tree with the design's connector bus: trunk → horizontal → drops. */
function TreeView({
  departments,
  boss,
  zoom,
  collapsed,
  onToggle,
  onOpen,
  onOpenDept,
  activeMemberId,
  activeDeptId,
  totalMembers,
  onHire,
  onZoom,
  collapsedMembers,
  onToggleMember,
}: {
  departments: DepartmentNode[];
  /** The one human: the root card is a person, not a hard-coded label. */
  boss: { name: string; avatar?: string };
  zoom: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (member: OrgMember) => void;
  onOpenDept: (departmentId: string) => void;
  activeMemberId: string;
  activeDeptId: string;
  totalMembers: number;
  onHire: (departmentId: string) => void;
  onZoom: {
    zoom: number;
    in: () => void;
    out: () => void;
    reset: () => void;
    step: (delta: number) => void;
  };
  collapsedMembers: Set<string>;
  onToggleMember: (id: string) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  // The scaled chart must reserve scaled space, otherwise zoom only shrinks pixels
  // and the scroll area stays the size of the unscaled layout.
  const content = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  // Roots of what is being shown: with no scope that is every top-level department;
  // when a department is focused, its subtree is rendered from that department down.
  const roots = departments.filter(
    (node) => !node.parentId || !departments.some((parent) => parent.id === node.parentId),
  );

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoom.step(event.deltaY > 0 ? -0.1 : 0.1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [onZoom]);

  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setNatural({ w: element.offsetWidth, h: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative h-full min-h-0">
    <div
      ref={ref}
      data-testid="org-canvas"
      onPointerDown={(event) => {
        const canvas = ref.current;
        if (!canvas || (event.target as HTMLElement).closest('[data-org-card]')) return;
        pan.current = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
        canvas.setPointerCapture(event.pointerId);
        setPanning(true);
      }}
      onPointerMove={(event) => {
        const canvas = ref.current;
        const start = pan.current;
        if (!canvas || !start) return;
        canvas.scrollLeft = start.left - (event.clientX - start.x);
        canvas.scrollTop = start.top - (event.clientY - start.y);
      }}
      onPointerUp={() => {
        pan.current = null;
        setPanning(false);
      }}
      className={cn('h-full overflow-auto', panning ? 'cursor-grabbing' : 'cursor-grab')}
      style={{
        backgroundImage: 'radial-gradient(circle, var(--border-strong) 1px, transparent 1px)',
        backgroundSize: '18px 18px',
        backgroundAttachment: 'local',
      }}
    >
      <div
        className="flex items-start justify-center p-10 pb-24"
        style={{ width: natural.w * zoom || undefined, height: natural.h * zoom || undefined }}
      >
        <div
          ref={content}
          style={{ transform: `scale(${zoom})`, transformOrigin: '0 0' }}
          className="flex w-max flex-col items-center"
        >
          {/* Root: the boss */}
          <div
            data-org-card
            className="w-[20rem] overflow-hidden rounded-2xl border border-accent/30 bg-surface shadow-[0_8px_24px_-10px_rgba(0,153,255,0.4)]"
          >
            <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
              <Avatar name={boss.name} src={boss.avatar} size="lg" status="online" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-lg font-bold text-ink">{boss.name}</span>
                  <span className="rounded bg-accent px-1.5 text-2xs font-semibold text-white">CEO</span>
                </div>
                <div className="mt-0.5 text-xs text-ink-tertiary">{t('org.founderRole')}</div>
              </div>
              <Crown className="size-4 shrink-0 text-warning" />
            </div>
            <div className="grid grid-cols-3 border-t border-line bg-accent-soft/40 py-2 text-center">
              <Metric value={String(roots.length)} label={t('org.directDepartments')} />
              <Metric value={String(totalMembers)} label={t('org.people')} className="border-x border-line" />
              <Metric value={String(departments.filter((node) => node.headEmployeeId).length)} label={t('org.heads')} />
            </div>
          </div>

          {departments.length > 0 ? (
            <DeptRow
              nodes={roots}
              all={departments}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpen={onOpen}
              onOpenDept={onOpenDept}
              onHire={onHire}
              activeMemberId={activeMemberId}
              activeDeptId={activeDeptId}
              collapsedMembers={collapsedMembers}
              onToggleMember={onToggleMember}
            />
          ) : null}
        </div>
      </div>
    </div>

      {/* Canvas controls, bottom-right like the design */}
      <div className="pointer-events-auto absolute right-4 bottom-4 flex items-center gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-card">
        <button
          type="button"
          aria-label={t('org.zoomOut')}
          data-testid="canvas-zoom-out"
          onClick={onZoom.out}
          className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-hover"
        >
          <ZoomOut className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onZoom.reset}
          title={t('org.zoomReset')}
          className="h-7 w-11 rounded-md font-mono text-2xs text-ink hover:bg-surface-hover"
        >
          {Math.round(onZoom.zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label={t('org.zoomIn')}
          data-testid="canvas-zoom-in"
          onClick={onZoom.in}
          className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-surface-hover"
        >
          <ZoomIn className="size-3.5" />
        </button>
      </div>

      {/* Status legend, bottom-left like the design */}
      <div
        data-testid="canvas-legend"
        className="absolute bottom-4 left-4 flex items-center gap-3 rounded-lg border border-line bg-surface/90 px-3 py-1.5 text-2xs text-ink-tertiary shadow-card backdrop-blur"
      >
        {(
          [
            ['active', t('org.active'), 'var(--success)'],
            ['working', t('org.legendWorking'), 'var(--accent)'],
            ['terminated', t('org.terminated'), 'var(--text-quaternary)'],
          ] as const
        ).map(([key, label, color]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="h-3 w-px bg-line" />
        <span className="font-mono">
          {departments.filter((node) => node.members.some((member) => member.activeTasks > 0)).length}/
          {departments.length} {t('org.legendBusyUnits')}
        </span>
      </div>
    </div>
  );
} 

/**
 * One level of the org chart: a horizontal bus, and one column per department.
 *
 * Recursive, because a department can have departments under it — the chart used to
 * be a single flat row, which is what made `parent_id` decorative. The bus lines are
 * drawn by each column's two half-rules so the row stays centred however many
 * children there are.
 */
interface DeptTreeProps {
  collapsed: Set<string>;
  collapsedMembers: Set<string>;
  onToggle: (id: string) => void;
  onToggleMember: (id: string) => void;
  onOpen: (member: OrgMember) => void;
  onOpenDept: (departmentId: string) => void;
  onHire: (departmentId: string) => void;
  activeMemberId: string;
  activeDeptId: string;
}

function DeptRow({ nodes, all, ...props }: DeptTreeProps & { nodes: DepartmentNode[]; all: DepartmentNode[] }) {
  if (nodes.length === 0) return null;

  return (
    <div className="flex flex-col items-center">
      <span className="h-7 w-px" style={{ background: LINE }} />
      <div className="flex items-start">
        {nodes.map((node, index) => (
          <div key={node.id || 'unassigned'} className="relative flex flex-col items-center px-3 pt-7">
            {index > 0 ? (
              <span className="absolute top-0 right-1/2 left-0 h-px" style={{ background: LINE }} />
            ) : null}
            {index < nodes.length - 1 ? (
              <span className="absolute top-0 right-0 left-1/2 h-px" style={{ background: LINE }} />
            ) : null}
            <span className="absolute top-0 left-1/2 h-7 w-px" style={{ background: LINE }} />

            <DeptCard node={node} all={all} {...props} />

            {props.collapsed.has(node.id) ? null : (
              <DeptRow nodes={childrenOf(all, node.id)} all={all} {...props} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DeptCard({ node, all, ...props }: DeptTreeProps & { node: DepartmentNode; all: DepartmentNode[] }) {
  const { t } = useTranslation();
  const isCollapsed = props.collapsed.has(node.id);
  const kids = childrenOf(all, node.id);
  const total = node.members.length + kids.reduce((sum, child) => sum + child.members.length, 0);

  return (
    <div
      data-org-card
      data-testid="org-card"
      role="button"
      tabIndex={0}
      onClick={() => props.onOpenDept(node.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') props.onOpenDept(node.id);
      }}
      className={cn(
        'w-[15.5rem] cursor-pointer overflow-hidden rounded-xl border bg-surface shadow-card transition-colors',
        props.activeDeptId === node.id ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-ink/20',
      )}
    >
      <div className="h-[3px]" style={{ background: node.color }} />
      <div className="p-3">
        <div className="flex items-start gap-2.5">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-lg"
            style={{ background: `${node.color}1A`, color: node.color }}
          >
            <Building2 className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-bold leading-tight text-ink">{node.name}</div>
            <div className="mt-0.5 truncate text-2xs text-ink-tertiary">
              {node.members.length} {t('org.people')}
              {kids.length > 0 ? ` · ${t('org.subDepartments', { count: kids.length })}` : ''}
              {node.code ? ` · ${node.code}` : ''}
            </div>
          </div>
          <button
            type="button"
            aria-label={t('org.hire')}
            onClick={(event) => {
              event.stopPropagation();
              props.onHire(node.id);
            }}
            className="rounded p-1 text-ink-quaternary hover:bg-ink/5 hover:text-accent"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-line px-3 py-1">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle(node.id);
          }}
          className="text-2xs text-ink-tertiary hover:text-ink"
        >
          {isCollapsed ? `${t('org.expand')} ▸` : `${t('org.collapse')} ▾`}
        </button>
        <span className="font-mono text-2xs text-ink-quaternary">
          {node.members.filter((member) => member.status === 'active').length}/{total}
        </span>
      </div>

      {isCollapsed ? null : (
        <div className="border-t border-line">
          <MemberTree
            members={node.members}
            onOpen={props.onOpen}
            activeMemberId={props.activeMemberId}
            collapsed={props.collapsedMembers}
            onToggle={props.onToggleMember}
          />
        </div>
      )}
    </div>
  );
}

function BoardView({
  departments,
  scopeIds,
  onOpen,
  onOpenDept,
  onHire,
  onTransfer,
  onStartDm,
  onOpenDeptGroup,
  activeMemberId,
}: {
  departments: DepartmentNode[];
  scopeIds?: Set<string>;
  onOpen: (member: OrgMember) => void;
  onOpenDept: (departmentId: string) => void;
  onHire: (departmentId: string) => void;
  onTransfer: (employeeId: string, departmentId: string) => void;
  onStartDm: (employeeId: string) => void;
  onOpenDeptGroup: (departmentId: string) => void;
  activeMemberId: string;
}) {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overDeptId, setOverDeptId] = useState<string | null>(null);
  const scopedName = departments.find(
    (node) =>
      node.id &&
      scopeIds?.has(node.id) &&
      // The focused root is the one whose parent is not part of the scope.
      !(node.parentId && scopeIds?.has(node.parentId)),
  )?.name;
  const dragging = departments.flatMap((node) => node.members).find((member) => member.id === draggingId);

  useEffect(() => {
    if (!scopeIds) return;
    const scroller = scrollerRef.current;
    const column = scroller?.querySelector<HTMLElement>('[data-in-scope="true"]');
    if (!scroller || !column) return;
    scroller.scrollTo({
      left: column.offsetLeft - (scroller.clientWidth - column.offsetWidth) / 2,
      behavior: 'smooth',
    });
  }, [scopeIds]);

  const endDrag = () => {
    setDraggingId(null);
    setOverDeptId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-5 pt-3 text-2xs text-ink-tertiary">
        <Move className="size-3.5" />
        <span className="truncate">
          {scopedName
            ? t('org.focusHint', { name: scopedName })
            : t('org.boardDragHint')}
        </span>
      </div>

      <div ref={scrollerRef} className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pt-2.5 pb-5">
        {departments.map((node) => {
          const outOfScope = Boolean(scopeIds) && !scopeIds!.has(node.id);
          const lead = node.members.find((member) => member.isHead);
          const spend = node.members.reduce((sum, member) => sum + member.costTodayUsd, 0);
          const canDrop = Boolean(dragging) && dragging!.departmentId !== node.id;
          const isOver = canDrop && overDeptId === node.id;

          return (
            <section
              key={node.id}
              data-dept-col={node.id}
              data-in-scope={outOfScope ? 'false' : 'true'}
              data-testid="board-column"
              onDragOver={(event) => {
                if (!canDrop) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (overDeptId !== node.id) setOverDeptId(node.id);
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setOverDeptId((current) => (current === node.id ? null : current));
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging && canDrop) onTransfer(dragging.id, node.id);
                endDrag();
              }}
              className={cn(
                'flex min-h-0 shrink-0 flex-col rounded-xl border transition-colors',
                outOfScope ? 'w-[13.75rem]' : 'w-[17.5rem]',
                isOver
                  ? 'border-dashed border-accent bg-accent-soft'
                  : canDrop
                    ? 'border-dashed border-accent/40 bg-surface-muted'
                    : outOfScope
                      ? 'border-transparent bg-surface-muted opacity-70'
                      : 'border-transparent bg-surface-muted',
              )}
            >
              <header className="shrink-0 px-3 pt-3 pb-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: node.color }}
                  />
                  <button
                    type="button"
                    onClick={() => onOpenDept(node.id)}
                    title={t('org.deptDetail')}
                    className="truncate text-sm-plus font-semibold text-ink hover:text-accent"
                  >
                    {node.name}
                  </button>
                  <span className="shrink-0 rounded bg-surface px-1.5 font-mono text-2xs text-ink-tertiary">
                    {node.members.length}
                  </span>
                  <span className="flex-1" />
                  <button
                    type="button"
                    title={t('org.openGroup')}
                    aria-label={t('org.openGroup')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenDeptGroup(node.id);
                    }}
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface hover:text-accent"
                  >
                    <Users className="size-3.5" />
                  </button>
                </div>
                <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-[18px] text-2xs text-ink-quaternary">
                  <span className="truncate">
                    {lead ? `${t('org.head')} ${lead.name}` : t('org.headVacant')}
                  </span>
                  <span className="shrink-0">·</span>
                  <span className="shrink-0 font-mono text-success">${spend.toFixed(2)}/d</span>
                  {outOfScope ? (
                    <span className="shrink-0 rounded bg-surface px-1 text-3xs">{t('org.outOfScope')}</span>
                  ) : null}
                </div>
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2">
                {isOver ? (
                  <div className="flex h-[60px] items-center justify-center rounded-[10px] border-2 border-dashed border-accent/50 bg-surface/70 text-2xs text-accent">
                    {t('org.dropToTransfer', { name: node.name })}
                  </div>
                ) : null}

                {node.members.map((member) => (
                  <div
                    key={member.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', member.id);
                      event.dataTransfer.effectAllowed = 'move';
                      setDraggingId(member.id);
                    }}
                    onDragEnd={endDrag}
                    role="button"
                    tabIndex={0}
                    data-testid="org-member"
                    onClick={() => onOpen(member)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') onOpen(member);
                    }}
                    className={cn(
                      'group cursor-grab rounded-[10px] border bg-surface p-3 transition-all active:cursor-grabbing',
                      draggingId === member.id ? 'opacity-40' : '',
                      member.id === activeMemberId
                        ? 'border-accent shadow-[0_0_0_3px_rgba(0,153,255,0.12)]'
                        : 'border-line hover:shadow-card',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <Avatar
                        name={member.name}
                        src={member.avatar || undefined}
                        size="sm"
                        status={member.activeTasks > 0 ? 'working' : member.status === 'active' ? 'online' : 'idle'}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1">
                          <span className="truncate text-sm-plus font-semibold text-ink">{member.name}</span>
                          <span className="rounded bg-surface-muted px-1 font-mono text-3xs text-ink-tertiary">
                            {member.level}
                          </span>
                          {member.isHead ? (
                            <span className="rounded bg-accent-soft px-1 text-3xs text-accent-ink">
                              {t('org.head')}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 truncate text-2xs text-ink-quaternary">{member.role}</div>
                      </div>
                      <button
                        type="button"
                        title={t('org.startDm')}
                        aria-label={t('org.startDm')}
                        onClick={(event) => {
                          event.stopPropagation();
                          onStartDm(member.id);
                        }}
                        className="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-accent opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent-soft focus-visible:opacity-100"
                      >
                        <MessageSquare className="size-3.5" />
                      </button>
                    </div>

                    <div className="mt-2.5 flex min-w-0 items-center gap-1 text-2xs text-ink-tertiary">
                      <Cpu className="size-3 shrink-0 text-accent" />
                      <span className="truncate">{member.model || t('wizard.inheritModel')}</span>
                    </div>

                    <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2.5">
                      <MemberStatus member={member} />
                      <span className="truncate text-2xs text-ink-quaternary">
                        <span className="font-mono text-success">${member.costTodayUsd.toFixed(2)}</span>
                        {' · '}
                        {member.tasksDone} {t('org.ordersShort')}
                      </span>
                    </div>
                  </div>
                ))}

                {!outOfScope && node.members.length === 0 ? (
                  <p className="py-8 text-center text-2xs text-ink-quaternary">{t('org.boardEmpty')}</p>
                ) : null}
              </div>

              <div className="shrink-0 p-2">
                <button
                  type="button"
                  data-testid="board-hire"
                  onClick={() => onHire(node.id)}
                  className="flex h-8 w-full items-center justify-center gap-1 rounded-lg text-xs text-ink-tertiary transition-colors hover:bg-surface hover:text-accent"
                >
                  <Plus className="size-3.5" />
                  {t('org.hireInto')}
                </button>
              </div>
            </section>
          );
        })}
        <div className="w-2 shrink-0" />
      </div>
    </div>
  );
}

/** "执行中 / 在线待命 / 离职" derived from live task count, never stored twice. */
function MemberStatus({ member }: { member: OrgMember }) {
  const { t } = useTranslation();
  const tone =
    member.status !== 'active'
      ? { label: t('org.terminated'), className: 'bg-ink/10 text-ink-tertiary', dot: 'var(--text-quaternary)' }
      : member.activeTasks > 0
        ? { label: t('org.legendWorking'), className: 'bg-accent-soft text-accent-ink', dot: 'var(--accent)' }
        : { label: t('org.statusStandby'), className: 'bg-success/12 text-success', dot: 'var(--success)' };

  return (
    <span className={cn('flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs', tone.className)}>
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: tone.dot }} />
      {tone.label}
    </span>
  );
}

function RosterView({
  departments,
  scopeIds,
  onOpen,
  membersById,
}: {
  departments: DepartmentNode[];
  scopeIds?: Set<string>;
  onOpen: (member: OrgMember) => void;
  membersById: Map<string, OrgMember>;
}) {
  const { t } = useTranslation();
  const rows = departments.flatMap((node) => node.members.map((member) => ({ member, department: node })));
  const scopedName = departments.find(
    (node) => node.id && scopeIds?.has(node.id) && !(node.parentId && scopeIds?.has(node.parentId)),
  )?.name;

  return (
    <div className="flex h-full min-h-0 flex-col px-5 py-3">
      <div className="flex shrink-0 items-center gap-1.5 pb-2 text-2xs text-ink-quaternary">
        <Move className="size-3.5" />
        <span className="truncate">
          {scopedName ? t('org.focusHint', { name: scopedName }) : t('org.rosterHint')}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-surface">
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-surface-muted text-2xs text-ink-tertiary">
            <tr>
              <th className="px-3 py-2 text-left font-medium">{t('org.col.member')}</th>
              <th className="w-[8rem] px-2 py-2 text-left font-medium">{t('org.col.title')}</th>
              <th className="w-[7rem] px-2 py-2 text-left font-medium">{t('org.departments')}</th>
              <th className="w-[7rem] px-2 py-2 text-left font-medium">{t('org.col.reportsTo')}</th>
              <th className="w-[5rem] px-2 py-2 text-right font-medium">{t('org.col.tasks')}</th>
              <th className="w-[6rem] px-2 py-2 text-right font-medium">{t('org.tokens')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ member, department }) => (
              <tr
                key={member.id}
                data-testid="org-member"
                onClick={() => onOpen(member)}
                className={cn(
                  'cursor-pointer border-t border-line hover:bg-surface-hover',
                  scopeIds ? (scopeIds.has(department.id) ? 'bg-accent-soft/50' : 'opacity-50') : '',
                )}
              >
                <td className="px-3 py-1.5">
                  <div className="flex items-center gap-2">
                    <Avatar
            name={member.name}
            src={member.avatar || undefined}
            size="sm"
            status={member.status === 'active' ? 'online' : 'idle'}
          />
                    <div className="min-w-0">
                      <div className="truncate text-sm-plus font-medium text-ink">{member.name}</div>
                      <div className="truncate text-2xs text-ink-quaternary">{member.role}</div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-1.5 text-xs text-ink-secondary">{member.title}</td>
                <td className="px-2 py-1.5 text-xs text-ink-tertiary">{department.name}</td>
                <td className="px-2 py-1.5 text-xs text-ink-tertiary">
                  {member.reportsToEmployeeId ? (membersById.get(member.reportsToEmployeeId)?.name ?? '—') : '—'}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-ink-tertiary">{member.activeTasks}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-ink-tertiary">{member.tokensUsed.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BadgeView({
  departments,
  scopeIds,
  onOpen,
  activeMemberId,
}: {
  departments: DepartmentNode[];
  scopeIds?: Set<string>;
  onOpen: (member: OrgMember) => void;
  activeMemberId: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="space-y-6">
        {departments.map((node) => (
          <section
            key={node.id || 'unassigned'}
            data-testid="badge-group"
            className={cn(
              'rounded-xl transition-opacity',
              scopeIds && !scopeIds.has(node.id) ? 'opacity-50' : '',
              scopeIds && scopeIds.has(node.id) ? 'ring-1 ring-accent' : '',
            )}
          >
            <div className="mb-2.5 flex items-center gap-2">
              <span aria-hidden className="h-4 w-1 rounded-full" style={{ background: node.color }} />
              <h3 className="text-base-plus font-bold text-ink">{node.name}</h3>
              <span className="text-2xs text-ink-quaternary">{node.members.length}</span>
              {scopeIds && !scopeIds.has(node.id) ? (
                <span className="rounded bg-surface-muted px-1 text-3xs text-ink-quaternary">{t('org.outOfScope')}</span>
              ) : null}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] gap-3.5">
              {node.members.map((member) => (
                <button
                  key={member.id}
                  type="button"
                  data-testid="org-member"
                  onClick={() => onOpen(member)}
                  className={cn(
                    'rounded-2xl border bg-surface p-3.5 text-left transition-all',
                    member.id === activeMemberId ? 'border-accent shadow-[0_0_0_3px_rgba(0,153,255,0.12)]' : 'border-line hover:shadow-card',
                  )}
                >
                  <div className="flex items-center gap-2.5">
                    <Avatar
                      name={member.name}
                      src={member.avatar || undefined}
                      size="md"
                      status={member.status === 'active' ? 'online' : 'idle'}
                    />
                    <div className="min-w-0">
                      <div className="truncate text-sm-plus font-semibold text-ink">{member.name}</div>
                      <div className="truncate text-2xs text-ink-quaternary">{member.role}</div>
                    </div>
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-1">
                    <span className="rounded bg-surface-muted px-1.5 font-mono text-3xs text-ink-tertiary">{member.level}</span>
                    {member.isHead ? <span className="rounded bg-accent-soft px-1.5 text-3xs text-accent-ink">{t('org.head')}</span> : null}
                    {member.status !== 'active' ? <span className="rounded bg-danger/10 px-1.5 text-3xs text-danger">{t('org.left')}</span> : null}
                  </div>
                  <div className="mt-2 flex items-center justify-between border-t border-line pt-2 text-3xs text-ink-quaternary">
                    <span>{member.activeTasks} {t('org.tasksShort')}</span>
                    <span className="font-mono">{member.tokensUsed.toLocaleString()}</span>
                  </div>
                </button>
              ))}
              {node.members.length === 0 ? <p className="text-2xs text-ink-quaternary">{t('org.empty')}</p> : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function DepartmentSummary({
  department,
  departments,
  onHire,
  onOpenGroup,
  onOpenMember,
  onUpdate,
  onArchive,
  onAppointHead,
  onAppointActingHead,
}: {
  department?: DepartmentNode;
  departments: DepartmentNode[];
  onHire: () => void;
  onOpenGroup: () => void;
  onOpenMember: (member: OrgMember) => void;
  onUpdate: (input: DepartmentEditInput) => void;
  onArchive: () => void;
  onAppointHead: (employeeId: string | null) => void;
  onAppointActingHead: (employeeId: string | null) => void;
}) {
  const { t } = useTranslation();
  if (!department) return <p className="text-sm text-ink-tertiary">{t('org.pickDepartment')}</p>;

  const lead = department.members.find((member) => member.isHead);
  const acting = department.members.find((member) => member.isActingHead);
  const spend = department.members.reduce((sum, member) => sum + member.costTodayUsd, 0);
  const done = department.members.reduce((sum, member) => sum + member.tasksDone, 0);
  const working = department.members.filter((member) => member.activeTasks > 0).length;
  const parent = department.parentId
    ? departments.find((node) => node.id === department.parentId)
    : undefined;

  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <span
            className="flex size-11 shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${department.color}1A`, color: department.color }}
          >
            <Building2 className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base-plus leading-snug font-bold text-ink">{department.name}</h3>
            <div className="mt-0.5 font-mono text-2xs text-ink-quaternary">{department.code || '—'}</div>
            <div className="mt-0.5 text-2xs text-ink-tertiary">
              {parent ? parent.name : t('org.topLevel')}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-secondary">{department.description || '—'}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={onOpenGroup} className={cn(buttonClass.primary)}>
            <Users className="size-3.5" />
            {t('org.openGroup')}
          </button>
          <button type="button" onClick={onHire} className={cn(buttonClass.secondary)}>
            <UserPlus className="size-3.5" />
            {t('org.hireInto')}
          </button>
        </div>
      </div>

      <DossierSection title={t('org.deptMetrics')}>
        <div className="grid grid-cols-2 gap-2">
          <StatTile label={t('org.people')} value={`${department.members.length}`} />
          <StatTile label={t('org.legendWorking')} value={String(working)} accent="text-accent" />
          <StatTile label={t('org.dailyCost')} value={`$${spend.toFixed(2)}`} accent="text-success" />
          <StatTile label={t('org.tasksDone')} value={`${done} ${t('org.ordersShort')}`} />
        </div>
      </DossierSection>

      <DepartmentFacts departmentId={department.id} />

      <DepartmentJobs departmentId={department.id} members={department.members} onHire={onHire} />

      <DepartmentSettings
        department={department}
        departments={departments}
        onUpdate={onUpdate}
        onArchive={onArchive}
      />

      <DossierSection title={t('org.head')}>
        {lead ? (
          <MemberRow member={lead} isLead onClick={() => onOpenMember(lead)} />
        ) : (
          <p className="text-xs text-ink-quaternary">{t('org.headVacant')}</p>
        )}
        <select
          data-testid="dept-head-select"
          value={lead?.id ?? ''}
          onChange={(event) => onAppointHead(event.target.value || null)}
          className="mt-2 h-7 w-full rounded-md bg-surface-muted px-2 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">{t('org.headNone')}</option>
          {department.members
            .filter((member) => member.status === 'active')
            .map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} · {member.title}
              </option>
            ))}
        </select>

        <div className="mt-2.5 flex items-center gap-2 text-xs">
          <span className="flex shrink-0 items-center gap-1 text-ink-tertiary">
            <UserCog className="size-3.5" />
            {t('org.actingHead')}
          </span>
          <select
            data-testid="dept-acting-head"
            value={acting?.id ?? ''}
            onChange={(event) => onAppointActingHead(event.target.value || null)}
            className="h-7 min-w-0 flex-1 rounded-md bg-surface-muted px-2 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('org.actingHeadNone')}</option>
            {department.members
              .filter((member) => member.status === 'active' && member.id !== lead?.id)
              .map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} · {member.title}
                </option>
              ))}
          </select>
        </div>
      </DossierSection>

      <DossierSection title={`${t('org.members')} · ${department.members.length}`}>
        {department.members.length > 0 ? (
          <div className="space-y-px">
            {department.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                isLead={member.id === lead?.id}
                onClick={() => onOpenMember(member)}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-ink-quaternary">{t('org.empty')}</p>
        )}
      </DossierSection>
    </>
  );
}

/**
 * Headcount slots for one department.
 *
 * `filled / headcount` is the only number here that the boss actually acts on: it is
 * what refuses the next hire. `filled` is derived from live seats by the service, so
 * the two can never drift apart the way a stored counter would.
 */
function DepartmentJobs({
  departmentId,
  members,
  onHire,
}: {
  departmentId: string;
  members: OrgMember[];
  onHire: () => void;
}) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<JobNode[]>([]);
  const [title, setTitle] = useState('');
  const [headcount, setHeadcount] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setJobs(await window.opc!.org.jobs(departmentId));
    } catch {
      setJobs([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const total = jobs.reduce((sum, job) => sum + job.headcount, 0);
  const filled = jobs.reduce((sum, job) => sum + job.filled, 0);
  // People without a slot are not hidden: a department whose jobs say 2/2 but has four
  // people is over establishment, and that is exactly what the boss needs to see.
  const unplanned = members.filter((member) => member.status === 'active' && !member.jobId).length;

  return (
    <DossierSection title={`${t('org.jobs')} · ${filled}/${total}`}>
      {unplanned > 0 ? (
        <p className="mb-1.5 text-2xs text-ink-quaternary">
          {t('org.jobsUnplanned', { count: unplanned })}
        </p>
      ) : null}
      {jobs.length === 0 ? (
        <p className="text-xs text-ink-quaternary">{t('org.jobsEmpty')}</p>
      ) : (
        <ul data-testid="dept-jobs" className="space-y-1.5">
          {jobs.map((job) => {
            const full = job.filled >= job.headcount;
            return (
              <li
                key={job.id}
                data-testid="dept-job-row"
                className="rounded-lg border border-line bg-surface-muted px-2.5 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-2xs font-medium text-ink">{job.title}</span>
                  <span className="shrink-0 rounded bg-surface px-1 font-mono text-3xs text-ink-tertiary">
                    {job.level}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 font-mono text-3xs',
                      full ? 'text-danger' : 'text-success',
                    )}
                  >
                    {job.filled}/{job.headcount}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1">
                  <div className="flex h-1 flex-1 gap-px overflow-hidden rounded-full bg-line">
                    {Array.from({ length: Math.max(job.headcount, 0) }).map((_, index) => (
                      <span
                        key={index}
                        className="flex-1"
                        style={{ background: index < job.filled ? 'var(--accent)' : 'transparent' }}
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    aria-label={t('org.jobHeadcount')}
                    title={t('org.jobHeadcount')}
                    onClick={() =>
                      void act(() =>
                        window.opc!.org.updateJob({ id: job.id, headcount: job.headcount + 1 }),
                      )
                    }
                    className="flex size-5 shrink-0 items-center justify-center rounded text-ink-quaternary hover:bg-ink/5 hover:text-ink"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label={t('org.jobRemove')}
                    title={t('org.jobRemove')}
                    onClick={() => void act(() => window.opc!.org.archiveJob(job.id))}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-ink-quaternary hover:bg-ink/5 hover:text-danger"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          data-testid="dept-job-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t('org.jobTitleHint')}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
        />
        <input
          data-testid="dept-job-headcount"
          value={headcount}
          inputMode="numeric"
          onChange={(event) => setHeadcount(event.target.value.replace(/[^\d]/g, ''))}
          aria-label={t('org.jobHeadcount')}
          className="h-7 w-12 shrink-0 rounded-md border border-line bg-surface px-2 text-center font-mono text-xs text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="dept-job-add"
          disabled={busy || !title.trim()}
          onClick={() =>
            void act(async () => {
              await window.opc!.org.createJob({
                departmentId,
                title: title.trim(),
                headcount: Number(headcount || '1'),
              });
              setTitle('');
              setHeadcount('1');
            })
          }
          className={cn(buttonClass.secondary, 'h-7 shrink-0 px-2 text-2xs disabled:opacity-40')}
        >
          <Plus className="size-3" />
        </button>
      </div>
      {jobs.some((job) => job.filled < job.headcount) ? (
        <button
          type="button"
          onClick={onHire}
          className="mt-1.5 flex h-7 w-full items-center justify-center gap-1 rounded-md text-2xs text-ink-tertiary hover:bg-surface-hover hover:text-accent"
        >
          <UserPlus className="size-3" />
          {t('org.hireInto')}
        </button>
      ) : null}
      {error ? <p className="mt-1 text-2xs text-danger">{error}</p> : null}
    </DossierSection>
  );
}

/**
 * Department rules: the facts every member of this department gets in its prompt.
 * Writing supersedes the previous value for the same subject (org_fact keeps history).
 */
function DepartmentFacts({ departmentId }: { departmentId: string }) {
  const { t } = useTranslation();
  const [facts, setFacts] = useState<OrgFactView[]>([]);
  const [subject, setSubject] = useState('');
  const [object, setObject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.opc!.facts
      .list({ departmentId })
      .then((rows) => {
        if (alive) setFacts(rows);
      })
      .catch(() => {
        if (alive) setFacts([]);
      });
    return () => {
      alive = false;
    };
  }, [departmentId]);

  const save = async () => {
    if (!subject.trim() || !object.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setFacts(
        await window.opc!.facts.write({
          scopeType: 'department',
          scopeId: departmentId,
          subject: subject.trim(),
          object: object.trim(),
        }),
      );
      setSubject('');
      setObject('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DossierSection title={`${t('org.deptRules')} · ${facts.length}`}>
      {facts.length === 0 ? (
        <p className="text-xs text-ink-quaternary">{t('org.deptRulesEmpty')}</p>
      ) : (
        <ul data-testid="dept-facts" className="space-y-1.5">
          {facts.map((fact) => (
            <li
              key={fact.id}
              data-testid="dept-fact-row"
              className="rounded-lg border border-line bg-surface-muted px-2.5 py-1.5"
            >
              <div className="truncate text-2xs font-medium text-ink">{fact.statement}</div>
              <div className="mt-0.5 font-mono text-3xs text-ink-quaternary">
                {fact.subject} · {new Date(fact.validFrom).toLocaleDateString()}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-1.5">
        <div className="grid grid-cols-2 gap-1.5">
          <input
            data-testid="dept-fact-subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('org.deptRuleSubject')}
            className="h-7 min-w-0 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
          />
          <input
            data-testid="dept-fact-object"
            value={object}
            onChange={(event) => setObject(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
            placeholder={t('org.deptRuleValue')}
            className="h-7 min-w-0 rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          data-testid="dept-fact-save"
          disabled={busy || !subject.trim() || !object.trim()}
          onClick={() => void save()}
          className={cn(buttonClass.secondary, 'h-7 w-full text-2xs disabled:opacity-40')}
        >
          {t('org.deptRuleSave')}
        </button>
        {error ? <p className="text-2xs text-danger">{error}</p> : null}
      </div>
    </DossierSection>
  );
}

/**
 * Rename / re-code / re-parent / archive.
 *
 * One section, because these are all "the card does not say what this department
 * actually is" edits and the boss reaches for them from the same panel. Re-parenting
 * is a plain select: the option list excludes the department's own subtree, so the
 * only way to try a cycle is to call the IPC directly — and the service refuses that
 * too.
 */
function DepartmentSettings({
  department,
  departments,
  onUpdate,
  onArchive,
}: {
  department: DepartmentNode;
  departments: DepartmentNode[];
  onUpdate: (input: DepartmentEditInput) => void;
  onArchive: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(department.name);
  const [code, setCode] = useState(department.code);
  const [description, setDescription] = useState(department.description);
  const [confirming, setConfirming] = useState(false);

  // Another department selected, or this one saved: start from what is stored.
  useEffect(() => {
    setName(department.name);
    setCode(department.code);
    setDescription(department.description);
    setConfirming(false);
  }, [department.id, department.name, department.code, department.description]);

  const dirty =
    name.trim() !== department.name ||
    code.trim().toUpperCase() !== department.code ||
    description.trim() !== department.description;
  const blocked = subtreeIds(departments, department.id);

  return (
    <DossierSection title={t('org.deptSettings')}>
      <div className="space-y-1.5">
        <input
          data-testid="dept-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('org.nameHint')}
          className="h-7 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
        />
        <input
          data-testid="dept-code"
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          placeholder={t('org.deptCode')}
          className="h-7 w-full rounded-md border border-line bg-surface px-2 font-mono text-xs text-ink outline-none focus:border-accent"
        />
        <textarea
          data-testid="dept-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t('org.deptDescriptionPlaceholder')}
          className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="dept-save"
          disabled={!dirty || !name.trim()}
          onClick={() =>
            onUpdate({
              id: department.id,
              name: name.trim(),
              code: code.trim().toUpperCase(),
              description: description.trim(),
            })
          }
          className={cn(buttonClass.secondary, 'h-7 w-full text-2xs disabled:opacity-40')}
        >
          {t('org.deptSave')}
        </button>

        <label className="mt-2 flex items-center gap-2 text-xs">
          <span className="flex shrink-0 items-center gap-1 text-ink-tertiary">
            <Network className="size-3.5" />
            {t('org.parentDepartment')}
          </span>
          <select
            data-testid="dept-parent"
            value={department.parentId ?? ''}
            onChange={(event) => onUpdate({ id: department.id, parentId: event.target.value || null })}
            className="h-7 min-w-0 flex-1 rounded-md bg-surface-muted px-2 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('org.topLevel')}</option>
            {departments
              .filter((node) => !blocked.has(node.id))
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
          </select>
        </label>

        {confirming ? (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
            <p className="text-2xs leading-relaxed text-danger">
              {t('org.archiveConfirm', { name: department.name })}
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="h-6 rounded-md px-2 text-2xs text-ink-tertiary hover:bg-ink/5"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="dept-archive-confirm"
                onClick={onArchive}
                className="h-6 rounded-md bg-danger px-2 text-2xs font-medium text-white"
              >
                {t('org.archiveDepartment')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            data-testid="dept-archive"
            onClick={() => setConfirming(true)}
            className="mt-2 flex h-7 w-full items-center justify-center gap-1 rounded-md border border-danger/30 text-2xs text-danger hover:bg-danger/5"
          >
            <X className="size-3" />
            {t('org.archiveDepartment')}
          </button>
        )}
      </div>
    </DossierSection>
  );
}

function MemberRow({ member, isLead, onClick }: { member: OrgMember; isLead: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover"
    >
      <Avatar
        name={member.name}
        src={member.avatar || undefined}
        size="xs"
        status={member.activeTasks > 0 ? 'working' : member.status === 'active' ? 'online' : 'idle'}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm-plus font-medium text-ink">{member.name}</span>
          <span className="rounded bg-surface-muted px-1 font-mono text-3xs text-ink-tertiary">{member.level}</span>
          {isLead ? <span className="rounded bg-accent-soft px-1 text-3xs text-accent-ink">负责人</span> : null}
        </div>
        <div className="truncate text-2xs text-ink-quaternary">{member.role}</div>
      </div>
      <ChevronRight className="size-3.5 shrink-0 text-ink-quaternary" />
    </button>
  );
}

function NewDepartmentModal({
  onClose,
  employees,
  departments,
  defaultParentId,
  onSubmit,
}: {
  employees: OrgMember[];
  departments: DepartmentNode[];
  defaultParentId?: string;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    code?: string;
    description?: string;
    headEmployeeId?: string;
    parentId?: string;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [headEmployeeId, setHeadEmployeeId] = useState('');
  const [parentId, setParentId] = useState(defaultParentId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        code: code.trim().toUpperCase() || undefined,
        description: description.trim() || undefined,
        headEmployeeId: headEmployeeId || undefined,
        parentId: parentId || undefined,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label={t('org.newDepartment')}
        className="w-[26rem] rounded-xl border border-line bg-surface shadow-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-base-plus font-semibold text-ink">{t('org.newDepartment')}</span>
          <button type="button" aria-label={t('common.close')} onClick={onClose} className="text-ink-tertiary hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <Field label={t('org.name')}>
            <input
              autoFocus
              data-testid="new-dept-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('org.nameHint')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label={t('org.deptCode')} hint={t('org.deptCodeHint')}>
            <input
              data-testid="new-dept-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="PD-01"
              className="h-8 w-full rounded-md border border-line bg-surface px-2 font-mono text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          <Field label={t('org.parentDepartment')} hint={t('org.topLevel')}>
            <select
              data-testid="new-dept-parent"
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">{t('org.topLevel')}</option>
              {departments.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('org.head')} hint={t('org.headHint')}>
            <select
              data-testid="new-dept-head"
              value={headEmployeeId}
              onChange={(event) => setHeadEmployeeId(event.target.value)}
              className="h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent"
            >
              <option value="">{t('org.headNone')}</option>
              {employees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name} · {employee.role}
                  {employee.departmentId ? '' : ` (${t('market.pool')})`}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('org.deptDescription')} hint={t('org.deptDescriptionHint')}>
            <textarea
              data-testid="new-dept-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t('org.deptDescriptionPlaceholder')}
              className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </Field>
          {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} className={buttonClass.secondary}>
            {t('common.cancel')}
          </button>
          <button type="button" onClick={() => void submit()} disabled={busy || !name.trim()} className={buttonClass.primary}>
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-secondary">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-2xs text-ink-quaternary">{hint}</span> : null}
    </label>
  );
}

function Metric({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  return (
    <div className={className}>
      <div className="text-sm-plus font-bold text-ink">{value}</div>
      <div className="text-3xs text-ink-quaternary">{label}</div>
    </div>
  );
}

function MemberDetail({
  member,
  boss,
  manager,
  reports,
  departments,
  onAvatar,
  onPersonnel,
  onStartDm,
  onOpenDeptGroup,
}: {
  member: OrgMember;
  /** The single human: the reporting chain starts at a person, not at a label. */
  boss: { name: string; avatar?: string };
  manager?: OrgMember;
  reports: OrgMember[];
  departments: DepartmentNode[];
  onAvatar: (dataUrl: string) => void;
  onPersonnel: (input: PersonnelInput) => void;
  onStartDm: (employeeId: string) => void;
  onOpenDeptGroup: (departmentId: string) => void;
}) {
  const { t } = useTranslation();
  const fileInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const department = departments.find((node) => node.id === member.departmentId);
  const color = department?.color ?? 'var(--accent)';

  const pickAvatar = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 128;
        const context = canvas.getContext('2d');
        if (!context) return;
        const side = Math.min(image.width, image.height);
        context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
        onAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      {/* Coloured banner, then the portrait overlapping it — design's profile head */}
      <div className="h-[72px]" style={{ background: `linear-gradient(135deg, ${color}33 0%, ${color}0A 100%)` }} />
      <div className="-mt-9 px-5 pb-4">
        <button
          type="button"
          data-testid="avatar-upload"
          title={t('org.uploadAvatar')}
          onClick={() => fileInput.current?.click()}
          className="group relative inline-flex rounded-full bg-surface ring-4 ring-surface"
        >
          <Avatar
            name={member.name}
            src={member.avatar || undefined}
            size="lg"
            status={member.activeTasks > 0 ? 'working' : member.status === 'active' ? 'online' : 'idle'}
          />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-ink/40 text-3xs text-white opacity-0 transition-opacity group-hover:opacity-100">
            {t('org.uploadAvatar')}
          </span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) pickAvatar(file);
            event.target.value = '';
          }}
        />

        <div className="mt-2.5 flex min-w-0 items-center gap-1.5">
          <h3 className="truncate text-lg font-bold text-ink">{member.name}</h3>
          <span className="rounded bg-surface-muted px-1 font-mono text-3xs text-ink-tertiary">{member.level}</span>
          {member.isHead ? (
            <span className="rounded bg-accent-soft px-1 text-3xs text-accent-ink">{t('org.head')}</span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-tertiary">{member.role}</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <MemberStatus member={member} />
          {department ? (
            <span
              className="inline-flex h-5 items-center rounded-full px-2 text-2xs font-medium"
              style={{ background: `${color}1A`, color }}
            >
              {department.name}
            </span>
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => onStartDm(member.id)} className={cn(buttonClass.primary)}>
            <MessageSquare className="size-3.5" />
            {t('org.startDm')}
          </button>
          <button
            type="button"
            onClick={() => department && onOpenDeptGroup(department.id)}
            disabled={!department}
            className={cn(buttonClass.secondary, 'disabled:opacity-40')}
          >
            <Users className="size-3.5" />
            {t('org.openGroup')}
          </button>
        </div>
      </div>

      <DossierSection title={t('org.reporting')}>
        <ol>
          {[
            { key: 'ceo', label: boss.name, role: t('org.founderRole'), onClick: undefined },
            ...(manager && manager.id !== member.id
              ? [
                  {
                    key: manager.id,
                    label: manager.name,
                    role: `${department?.name ?? ''} · ${t('org.col.reportsTo')}`,
                    onClick: undefined,
                  },
                ]
              : []),
            { key: member.id, label: member.name, role: member.role, onClick: undefined, current: true },
          ].map((node, index, list) => (
            <li key={node.key} className="relative flex items-center gap-2.5 pb-3 last:pb-0">
              {index < list.length - 1 ? (
                <span aria-hidden className="absolute top-6 bottom-0 left-[11.5px] w-px bg-line" />
              ) : null}
              <Avatar
                name={node.label}
                {...(node.key === 'ceo' && boss.avatar ? { src: boss.avatar } : {})}
                size="xs"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm-plus font-medium text-ink">{node.label}</div>
                <div className="truncate text-2xs text-ink-quaternary">{node.role}</div>
              </div>
              {'current' in node && node.current ? (
                <span className="shrink-0 rounded bg-surface-muted px-1.5 text-3xs leading-4 text-ink-tertiary">
                  {t('org.current')}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        {reports.length > 0 ? (
          <div className="mt-2 border-t border-line pt-2 text-2xs text-ink-quaternary">
            {t('org.subordinates')}：{reports.map((report) => report.name).join('、')}
          </div>
        ) : null}
      </DossierSection>

      <DossierSection title={t('org.service')}>
        <div className="grid grid-cols-[1fr_1fr_1.25fr] gap-2">
          <StatTile label={t('org.tasksDone')} value={`${member.tasksDone} ${t('org.ordersShort')}`} />
          <StatTile label={t('org.dailyCost')} value={`$${member.costTodayUsd.toFixed(2)}`} accent="text-success" />
          <StatTile label={t('org.hiredAt')} value={new Date(member.hiredAt || Date.now()).toLocaleDateString()} />
        </div>
        {member.terminatedAt ? (
          <p className="mt-2 text-2xs text-ink-quaternary">
            {t('org.terminatedAt')} {new Date(member.terminatedAt).toLocaleDateString()}
          </p>
        ) : null}
        {member.probationEndsAt ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-warning/10 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 truncate text-2xs text-ink-secondary">
              {t('org.probationUntil', { date: new Date(member.probationEndsAt).toLocaleDateString() })}
            </span>
            <button
              type="button"
              data-testid="confirm-probation"
              onClick={() => onPersonnel({ employeeId: member.id, action: 'confirm' })}
              className="h-6 shrink-0 rounded-md bg-accent px-2 text-2xs font-medium text-white"
            >
              {t('org.confirm')}
            </button>
          </div>
        ) : null}
      </DossierSection>

      <EmploymentTimeline employeeId={member.id} departments={departments} bossName={boss.name} />

      <PerformanceReviews employeeId={member.id} />

      <DossierSection title={t('org.stack')}>
        <div className="flex items-center gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs text-ink">
          <Cpu className="size-3.5 shrink-0 text-accent" />
          <span className="truncate">{member.model || t('wizard.inheritModel')}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {member.skills.length > 0 ? (
            member.skills.map((skill) => (
              <span key={skill} className="rounded-md bg-surface-muted px-2 py-0.5 text-2xs text-ink-secondary">
                {skill}
              </span>
            ))
          ) : (
            <span className="text-2xs text-ink-quaternary">—</span>
          )}
        </div>
      </DossierSection>

      {member.persona ? (
        <DossierSection title={t('wizard.persona')}>
          <pre className="max-h-48 overflow-y-auto rounded-lg border border-line bg-surface-muted p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-ink-secondary select-text">
            {member.persona}
          </pre>
        </DossierSection>
      ) : null}

      <DossierSection title={t('org.personnel')}>
        <label className="flex items-center gap-3 text-xs">
          <span className="flex shrink-0 items-center gap-1 text-ink-tertiary">
            <ArrowRightLeft className="size-3.5" />
            {t('org.transfer')}
          </span>
          <select
            value=""
            aria-label={t('org.transfer')}
            onChange={(event) => {
              if (event.target.value) {
                onPersonnel({ employeeId: member.id, action: 'transfer', departmentId: event.target.value });
                event.target.value = '';
              }
            }}
            className="h-8 min-w-0 flex-1 rounded-lg bg-surface-muted px-2 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('org.personnelPick')}</option>
            {departments
              .filter((node) => node.id && node.id !== member.departmentId)
              .map((node) => (
                <option key={node.id} value={node.id}>
                  {node.name}
                </option>
              ))}
          </select>
        </label>

        <label className="mt-2 flex items-center gap-3 text-xs">
          <span className="flex shrink-0 items-center gap-1 text-ink-tertiary">
            <Users className="size-3.5" />
            {t('org.col.reportsTo')}
          </span>
          <select
            value={member.reportsToEmployeeId ?? ''}
            aria-label={t('org.col.reportsTo')}
            onChange={(event) =>
              onPersonnel({ employeeId: member.id, action: 'set-manager', reportsToEmployeeId: event.target.value })
            }
            className="h-8 min-w-0 flex-1 rounded-lg bg-surface-muted px-2 text-xs text-ink outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('wizard.noManager')}</option>
            {departments
              .flatMap((node) => node.members)
              .filter((other) => other.id !== member.id && other.status === 'active')
              .map((other) => (
                <option key={other.id} value={other.id}>
                  {other.name}
                </option>
              ))}
          </select>
        </label>

        {member.status === 'active' ? (
          confirming ? (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3">
              <p className="text-xs leading-relaxed text-danger">
                {t('org.fireConfirm', { name: member.name })}
              </p>
              <div className="mt-2.5 flex justify-end gap-2">
                <button type="button" onClick={() => setConfirming(false)} className="h-7 rounded-md px-3 text-xs text-ink-tertiary hover:bg-ink/5">
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  data-testid="fire-confirm"
                  onClick={() => onPersonnel({ employeeId: member.id, action: 'terminate' })}
                  className="h-7 rounded-md bg-danger px-3 text-xs font-medium text-white"
                >
                  {t('org.fire')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              data-testid="fire-open"
              onClick={() => setConfirming(true)}
              className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-danger/30 text-xs text-danger hover:bg-danger/5"
            >
              <X className="size-3.5" />
              {t('org.fireMember')}
            </button>
          )
        ) : (
          <button
            type="button"
            onClick={() => onPersonnel({ employeeId: member.id, action: 'reinstate' })}
            className={cn(buttonClass.secondary, 'mt-3 w-full')}
          >
            {t('org.reinstate')}
          </button>
        )}

        <button
          type="button"
          data-testid="export-employee-package"
          onClick={() =>
            void window.opc!.market.exportPackage({
              kind: 'employee',
              name: member.name,
              employeeIds: [member.id],
            })
          }
          className={cn(buttonClass.secondary, 'mt-2 w-full')}
        >
          <PackagePlus className="size-3.5" />
          {t('org.exportPackage')}
        </button>
      </DossierSection>
    </>
  );
}

/**
 * The HR timeline for one person: what happened, when, and — for promotions — from
 * what to what. Derived nothing: these rows are written by the org service inside the
 * same transaction as the change, so the history cannot drift from the seat.
 */
/**
 * Performance reviews for one person.
 *
 * The list is the point: a single score is an opinion, a series is a trend, and the
 * trend is what a promotion decision is supposed to rest on. The form stays open so
 * writing one does not mean finding a separate page.
 */
function PerformanceReviews({ employeeId }: { employeeId: string }) {
  const { t } = useTranslation();
  const [reviews, setReviews] = useState<Evaluation[]>([]);
  const [score, setScore] = useState('4');
  const [kind, setKind] = useState<Evaluation['kind']>('periodic');
  const [periodKey, setPeriodKey] = useState('');
  const [summary, setSummary] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setReviews(await window.opc!.org.evaluations(employeeId));
    } catch {
      setReviews([]);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  const submit = async () => {
    const value = Number(score);
    if (busy || !Number.isFinite(value)) return;
    setBusy(true);
    setError(null);
    try {
      setReviews(
        await window.opc!.org.addEvaluation({
          employeeId,
          kind,
          periodKey: periodKey.trim() || undefined,
          scoreOverall: value,
          summary: summary.trim() || undefined,
        }),
      );
      setSummary('');
      setPeriodKey('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DossierSection title={`${t('org.reviews')} · ${reviews.length}`}>
      {reviews.length === 0 ? (
        <p className="text-xs text-ink-quaternary">{t('org.reviewsEmpty')}</p>
      ) : (
        <ul data-testid="reviews" className="space-y-1.5">
          {reviews.map((review) => (
            <li
              key={review.id}
              data-testid="review-row"
              className="rounded-lg border border-line bg-surface-muted px-2.5 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="rounded bg-surface px-1 text-3xs text-ink-tertiary">
                  {t(`org.reviewKind.${review.kind}`)}
                </span>
                {review.periodKey ? (
                  <span className="truncate font-mono text-3xs text-ink-quaternary">{review.periodKey}</span>
                ) : null}
                <span className="flex-1" />
                <span className="shrink-0 font-mono text-2xs font-semibold text-ink">
                  {review.scoreOverall.toFixed(1)}
                </span>
                <span className="shrink-0 text-3xs text-ink-quaternary">/5</span>
              </div>
              {review.summary ? (
                <p className="mt-1 line-clamp-2 text-2xs leading-relaxed text-ink-secondary">{review.summary}</p>
              ) : null}
              <div className="mt-0.5 font-mono text-3xs text-ink-quaternary">
                {new Date(review.at).toLocaleDateString()}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 space-y-1.5">
        <div className="flex gap-1.5">
          <select
            data-testid="review-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Evaluation['kind'])}
            className="h-7 min-w-0 flex-1 rounded-md border border-line bg-surface px-1.5 text-xs text-ink outline-none focus:border-accent"
          >
            {(['probation', 'periodic', 'project', 'exit'] as const).map((value) => (
              <option key={value} value={value}>
                {t(`org.reviewKind.${value}`)}
              </option>
            ))}
          </select>
          <input
            data-testid="review-score"
            value={score}
            inputMode="decimal"
            onChange={(event) => setScore(event.target.value.replace(/[^\d.]/g, ''))}
            aria-label={t('org.reviewScore')}
            className="h-7 w-12 shrink-0 rounded-md border border-line bg-surface px-1.5 text-center font-mono text-xs text-ink outline-none focus:border-accent"
          />
          <input
            data-testid="review-period"
            value={periodKey}
            onChange={(event) => setPeriodKey(event.target.value)}
            placeholder={t('org.reviewPeriodHint')}
            className="h-7 w-24 shrink-0 rounded-md border border-line bg-surface px-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
          />
        </div>
        <input
          data-testid="review-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          placeholder={t('org.reviewSummaryHint')}
          className="h-7 w-full rounded-md border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
        />
        <button
          type="button"
          data-testid="review-add"
          disabled={busy || !score.trim()}
          onClick={() => void submit()}
          className={cn(buttonClass.secondary, 'h-7 w-full text-2xs disabled:opacity-40')}
        >
          {t('org.reviewAdd')}
        </button>
        {error ? <p className="text-2xs text-danger">{error}</p> : null}
      </div>
    </DossierSection>
  );
}

function EmploymentTimeline({
  employeeId,
  departments,
  bossName,
}: {
  employeeId: string;
  departments: DepartmentNode[];
  /** `'boss'` is the only human actor; show their name rather than the literal id. */
  bossName: string;
}) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<EmploymentEvent[]>([]);

  useEffect(() => {
    let alive = true;
    void window.opc!.org
      .events(employeeId, 30)
      .then((rows) => {
        if (alive) setEvents(rows);
      })
      .catch(() => {
        if (alive) setEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [employeeId]);

  if (events.length === 0) return null;
  const nameOf = (id?: string) => (id ? departments.find((node) => node.id === id)?.name ?? '—' : '');

  return (
    <DossierSection title={`${t('org.timeline')} · ${events.length}`}>
      <ol data-testid="employment-timeline" className="space-y-2">
        {events.map((event, index) => (
          <li key={event.id} className="relative flex gap-2.5 pb-0.5">
            {index < events.length - 1 ? (
              <span aria-hidden className="absolute top-4 bottom-0 left-[3.5px] w-px bg-line" />
            ) : null}
            <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xs font-medium text-ink">{t(`org.event.${event.kind}`)}</span>
                <span className="font-mono text-3xs text-ink-quaternary">
                  {new Date(event.at).toLocaleDateString()}
                </span>
              </div>
              <div className="mt-0.5 truncate text-3xs text-ink-tertiary">
                {describeEvent(event, nameOf, t)}
              </div>
              <div className="mt-0.5 truncate text-3xs text-ink-quaternary">
                {event.actor === 'boss'
                  ? t('org.eventBy', { name: bossName })
                  : t('org.eventBy', { name: nameOf(event.actor) })}
                {event.reason ? ` · ${event.reason}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </DossierSection>
  );
}

/** One line per event kind: a move shows both ends, a promotion shows both levels. */
function describeEvent(
  event: EmploymentEvent,
  nameOf: (id?: string) => string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (event.kind) {
    case 'transferred':
      return event.fromDepartmentId
        ? `${nameOf(event.fromDepartmentId)} → ${nameOf(event.toDepartmentId)}`
        : nameOf(event.toDepartmentId);
    case 'promoted':
      return [event.fromLevel, event.toLevel].filter(Boolean).join(' → ') +
        (event.toTitle && event.toTitle !== event.fromTitle ? ` · ${event.toTitle}` : '');
    case 'reinstated':
      return nameOf(event.toDepartmentId);
    case 'confirmed':
      return nameOf(event.toDepartmentId);
    case 'hired':
    case 'head_appointed':
      return [nameOf(event.toDepartmentId), event.toTitle].filter(Boolean).join(' · ');
    case 'terminated':
    case 'head_removed':
      return [nameOf(event.fromDepartmentId), event.fromTitle].filter(Boolean).join(' · ');
    default:
      return t('org.event.unknown');
  }
}

function DossierSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line px-5 py-4">
      <h4 className="mb-2.5 text-2xs font-semibold text-ink-tertiary">{title}</h4>
      {children}
    </section>
  );
}

function StatTile({ label, value, accent = 'text-ink' }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-surface-muted px-2.5 py-2">
      <div className="text-3xs text-ink-quaternary">{label}</div>
      <div className={cn('mt-0.5 truncate font-mono text-sm font-semibold', accent)}>{value}</div>
    </div>
  );
}


/**
 * Members of one department as a reporting tree: a manager is followed by their
 * reports, indented, and can be collapsed. Status dot + skills come from the
 * employee row, so the card shows real data instead of fixture labels.
 */
function MemberTree({
  members,
  onOpen,
  activeMemberId,
  collapsed,
  onToggle,
  depth = 0,
}: {
  members: OrgMember[];
  onOpen: (member: OrgMember) => void;
  activeMemberId: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  depth?: number;
}) {
  const ids = new Set(members.map((member) => member.id));
  const roots = members.filter(
    (member) => !member.reportsToEmployeeId || !ids.has(member.reportsToEmployeeId),
  );
  const reportsOf = (id: string) => members.filter((member) => member.reportsToEmployeeId === id);

  return (
    <ul>
      {roots.map((member) => (
        <MemberNode
          key={member.id}
          member={member}
          reports={reportsOf(member.id)}
          onOpen={onOpen}
          activeMemberId={activeMemberId}
          collapsed={collapsed}
          onToggle={onToggle}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function MemberNode({
  member,
  reports,
  onOpen,
  activeMemberId,
  collapsed,
  onToggle,
  depth,
}: {
  member: OrgMember;
  reports: OrgMember[];
  onOpen: (member: OrgMember) => void;
  activeMemberId: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  depth: number;
}) {
  const isCollapsed = collapsed.has(member.id);

  return (
    <li>
      <div
        className={cn(
          'flex items-center gap-1.5 py-1 pr-2 transition-colors',
          member.id === activeMemberId ? 'bg-accent-soft' : 'hover:bg-surface-hover',
        )}
        style={{ paddingLeft: `${0.75 + depth * 0.75}rem` }}
      >
        {reports.length > 0 ? (
          <button
            type="button"
            aria-label={isCollapsed ? '展开下属' : '收起下属'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(member.id);
            }}
            className="shrink-0 text-ink-quaternary hover:text-ink"
          >
            <span className="text-3xs">{isCollapsed ? '▸' : '▾'}</span>
          </button>
        ) : (
          <span className="w-2 shrink-0" />
        )}

        <button
          type="button"
          data-testid="org-member"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(member);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="relative shrink-0">
            <Avatar name={member.name} src={member.avatar || undefined} size="sm" />
            <span
              aria-hidden
              className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface"
              style={{ background: member.status === 'active' ? 'var(--success)' : 'var(--text-quaternary)' }}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1">
              <span className="truncate text-sm text-ink">{member.name}</span>
              <span className="rounded bg-surface-muted px-1 font-mono text-3xs text-ink-tertiary">{member.level}</span>
              {member.isHead ? (
                <span className="rounded bg-accent-soft px-1 text-3xs text-accent-ink">负责人</span>
              ) : null}
              {member.status !== 'active' ? (
                <span className="rounded bg-danger/10 px-1 text-3xs text-danger">已离职</span>
              ) : null}
            </span>
            <span className="block truncate text-2xs text-ink-quaternary">{member.title}</span>
            {member.skills.length > 0 ? (
              <span className="mt-0.5 flex flex-wrap gap-1">
                {member.skills.slice(0, 3).map((skill) => (
                  <span key={skill} className="rounded bg-surface-muted px-1 text-3xs text-ink-tertiary">
                    {skill}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          {member.activeTasks > 0 ? (
            <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-3xs text-accent-ink">
              {member.activeTasks}
            </span>
          ) : null}
        </button>
      </div>

      {reports.length > 0 && !isCollapsed ? (
        <MemberTree
          members={reports}
          onOpen={onOpen}
          activeMemberId={activeMemberId}
          collapsed={collapsed}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ) : null}
    </li>
  );
}
