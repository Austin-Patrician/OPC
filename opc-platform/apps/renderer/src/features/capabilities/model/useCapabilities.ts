import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CapabilityCatalog,
  PiExtensionCatalog,
  PiExtensionView,
  PiSkillCatalog,
  PiSkillView,
  SkillPackCatalogView,
  SkillPackProgress,
  SkillPackView,
} from '@opc/shared/ipc';
import { distinctToolNames, groupExtensions } from './grouping';

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
  const [skillPacks, setSkillPacks] = useState<SkillPackCatalogView | null>(null);
  const [skillPackProgress, setSkillPackProgress] = useState<SkillPackProgress | null>(null);
  const [error, setError] = useState('');
  const [extensionError, setExtensionError] = useState('');
  const [busyExtension, setBusyExtension] = useState('');
  const [skillError, setSkillError] = useState('');
  const [busySkill, setBusySkill] = useState('');
  const [skillPackError, setSkillPackError] = useState('');
  const [busySkillPack, setBusySkillPack] = useState('');
  const [skillPackEnvBusy, setSkillPackEnvBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, found, discovered, packs] = await Promise.all([
        window.opc?.capabilities.list(),
        window.opc?.extensions.list(),
        window.opc?.skills.list(),
        window.opc?.skillPacks?.list(),
      ]);
      setCatalog(next ?? null);
      setExtensions(found ?? null);
      setSkills(discovered ?? null);
      setSkillPacks(packs ?? null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSnapshots = useCallback(async () => {
    const [refreshed, discovered] = await Promise.all([
      window.opc?.capabilities.list(),
      window.opc?.skills.list(),
    ]);
    if (refreshed) setCatalog(refreshed);
    if (discovered) setSkills(discovered);
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

  const toggleSkillPack = useCallback(
    async (pack: SkillPackView, next: boolean) => {
      if (!window.opc?.skillPacks) return;
      setBusySkillPack(pack.id);
      setSkillPackError('');
      try {
        const updated = await window.opc.skillPacks.setEnabled(pack.id, next);
        setSkillPacks(updated);
        await refreshSnapshots();
      } catch (cause) {
        setSkillPackError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusySkillPack('');
      }
    },
    [refreshSnapshots],
  );

  const runSkillPackEnvAction = useCallback(
    async (action: () => Promise<SkillPackCatalogView>) => {
      setSkillPackEnvBusy(true);
      setSkillPackError('');
      try {
        const updated = await action();
        setSkillPacks(updated);
        if (updated.env.error) setSkillPackError(updated.env.error);
        await refreshSnapshots();
      } catch (cause) {
        setSkillPackError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setSkillPackEnvBusy(false);
      }
    },
    [refreshSnapshots],
  );

  const enableAllSkillPacks = useCallback(async () => {
    if (!window.opc?.skillPacks) return;
    await runSkillPackEnvAction(() => window.opc!.skillPacks.enableAll());
  }, [runSkillPackEnvAction]);

  const prepareSkillPackEnv = useCallback(async () => {
    if (!window.opc?.skillPacks) return;
    await runSkillPackEnvAction(() => window.opc!.skillPacks.prepareEnv());
  }, [runSkillPackEnvAction]);

  const upgradeSkillPackEnv = useCallback(async () => {
    if (!window.opc?.skillPacks) return;
    await runSkillPackEnvAction(() => window.opc!.skillPacks.upgradeEnv());
  }, [runSkillPackEnvAction]);

  const uninstallSkillPackEnv = useCallback(async () => {
    if (!window.opc?.skillPacks) return;
    await runSkillPackEnvAction(() => window.opc!.skillPacks.uninstallEnv());
  }, [runSkillPackEnvAction]);

  useEffect(() => {
    void load();
    const bridge = window.opc?.skillPacks;
    if (!bridge) return undefined;
    const unsubChanged = bridge.onChanged(setSkillPacks);
    const unsubProgress = bridge.onProgress(setSkillPackProgress);
    return () => {
      unsubChanged();
      unsubProgress();
    };
  }, [load]);

  const agents = useMemo(() => catalog?.agents ?? [], [catalog]);
  const groups = useMemo(() => groupExtensions(agents), [agents]);
  const toolNames = useMemo(() => distinctToolNames(groups), [groups]);

  return {
    catalog,
    extensions,
    skills,
    skillPacks,
    skillPackProgress,
    error,
    extensionError,
    busyExtension,
    skillError,
    busySkill,
    skillPackError,
    busySkillPack,
    skillPackEnvBusy,
    loading,
    load,
    toggleExtension,
    toggleSkill,
    toggleSkillPack,
    enableAllSkillPacks,
    prepareSkillPackEnv,
    upgradeSkillPackEnv,
    uninstallSkillPackEnv,
    agents,
    groups,
    toolNames,
  };
}
