import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CapabilityCatalog,
  PiExtensionCatalog,
  PiExtensionView,
  PiSkillCatalog,
  PiSkillView,
} from '@opc/shared/ipc';
import { distinctToolNames, groupExtensions, toToolGroups } from './grouping';

/**
 * Data layer shared by the 技能与工具 settings pages.
 *
 * Extensions, tools and skills all read from the same runtime snapshot, so the
 * three pages must not each load (and drift) on their own. Keeping the load and
 * toggle logic here means a switch flipped on one page is reflected on refresh
 * of the others without any duplicated state machine.
 */
export function useCapabilities() {
  const [catalog, setCatalog] = useState<CapabilityCatalog | null>(null);
  const [extensions, setExtensions] = useState<PiExtensionCatalog | null>(null);
  const [skills, setSkills] = useState<PiSkillCatalog | null>(null);
  const [error, setError] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [busyExtension, setBusyExtension] = useState('');
  const [skillError, setSkillError] = useState('');
  const [busySkill, setBusySkill] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, found, discovered] = await Promise.all([
        window.opc?.capabilities.list(),
        window.opc?.extensions.list(),
        window.opc?.skills.list(),
      ]);
      setCatalog(next ?? null);
      setExtensions(found ?? null);
      setSkills(discovered ?? null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const toggleExtension = useCallback(async (entry: PiExtensionView, next: boolean) => {
    setBusyExtension(entry.id);
    setExtensionError('');
    try {
      const updated = await window.opc?.extensions.setEnabled(entry.id, next, true);
      if (updated) setExtensions(updated);
      // The registry changed, so the per-agent snapshot is stale as well.
      const refreshed = await window.opc?.capabilities.list();
      if (refreshed) setCatalog(refreshed);
    } catch (cause) {
      setExtensionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyExtension('');
    }
  }, []);

  const toggleSkill = useCallback(async (entry: PiSkillView, next: boolean) => {
    setBusySkill(entry.id);
    setSkillError('');
    try {
      const updated = await window.opc?.skills.setEnabled(entry.id, next);
      if (updated) setSkills(updated);
      // The skills prompt section is part of the registry, so refresh both.
      const refreshed = await window.opc?.capabilities.list();
      if (refreshed) setCatalog(refreshed);
    } catch (cause) {
      setSkillError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusySkill('');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = useMemo(() => catalog?.agents ?? [], [catalog]);
  const groups = useMemo(() => groupExtensions(agents), [agents]);
  const toolGroups = useMemo(() => toToolGroups(groups), [groups]);
  const toolNames = useMemo(() => distinctToolNames(groups), [groups]);

  return {
    catalog,
    extensions,
    skills,
    error,
    extensionError,
    busyExtension,
    skillError,
    busySkill,
    loading,
    load,
    toggleExtension,
    toggleSkill,
    agents,
    groups,
    toolGroups,
    toolNames,
  };
}
