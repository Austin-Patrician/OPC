import { create } from 'zustand';

/**
 * Ephemeral shell layout state (never persisted). Kept separate from UI prefs so
 * "what is open right now" dies with the session, while appearance survives.
 */
interface ShellState {
  dossierOpen: boolean;
  sessionListOpen: boolean;
  toggleDossier: () => void;
  closeDossier: () => void;
  toggleSessionList: () => void;
}

export const useShellStore = create<ShellState>((set) => ({
  dossierOpen: false,
  sessionListOpen: true,
  toggleDossier: () => set((state) => ({ dossierOpen: !state.dossierOpen })),
  closeDossier: () => set({ dossierOpen: false }),
  toggleSessionList: () => set((state) => ({ sessionListOpen: !state.sessionListOpen })),
}));
