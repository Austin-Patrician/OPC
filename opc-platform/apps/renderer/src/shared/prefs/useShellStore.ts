import { create } from 'zustand';

/**
 * Ephemeral shell layout state (never persisted). Kept separate from UI prefs so
 * "what is open right now" dies with the session, while appearance survives.
 *
 * 会话列表的开关随列表一起删了：不再有东西需要「收起/展开」。
 */
interface ShellState {
  dossierOpen: boolean;
  toggleDossier: () => void;
  closeDossier: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  dossierOpen: false,
  toggleDossier: () => set((state) => ({ dossierOpen: !state.dossierOpen })),
  closeDossier: () => set({ dossierOpen: false }),
}));
