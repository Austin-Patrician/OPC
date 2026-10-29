import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EmployeeToolPolicy, ModelRef, ProviderConfig } from '@opc/shared/domain';
import type { EmployeeStackInput, EmployeeStackView } from '@opc/shared/ipc';

export interface ModelChoice {
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
}

/**
 * Every model that can actually answer a message, flattened and grouped by
 * provider for the picker. Image/voice rows live in the same provider catalog
 * but are not valid choices for an employee's chat model.
 */
export function chatModelChoices(providers: readonly ProviderConfig[]): ModelChoice[] {
  return providers.flatMap((provider) =>
    provider.models
      .filter((model) => model.capability === 'chat' && model.chatEnabled !== false)
      .map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name || model.id,
      })),
  );
}

export function modelChoiceValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

export function parseModelChoice(value: string): { providerId: string; modelId: string } | null {
  if (!value) return null;
  const at = value.indexOf('::');
  if (at <= 0) return null;
  const providerId = value.slice(0, at);
  const modelId = value.slice(at + 2);
  return providerId && modelId ? { providerId, modelId } : null;
}

/** Human label for a stored ref, falling back to `provider/model` when it is gone. */
export function modelRefLabel(
  choices: readonly ModelChoice[],
  ref: ModelRef | null | undefined,
): string | null {
  if (!ref) return null;
  const match = choices.find(
    (choice) => choice.providerId === ref.providerId && choice.modelId === ref.modelId,
  );
  return match?.name ?? `${ref.providerId}/${ref.modelId}`;
}

interface StackState {
  view: EmployeeStackView | null;
  providers: ProviderConfig[];
  loading: boolean;
  saving: boolean;
  error: string | null;
}

/**
 * Data access for one employee's model + tool policy.
 *
 * Deliberately a hook rather than page code: the dossier is the first entry
 * point, but the hire wizard and any bulk provisioning screen can mount the
 * same editor without re-implementing load/save/optimistic state.
 */
export function useEmployeeStack(employeeId: string | null) {
  const [state, setState] = useState<StackState>({
    view: null,
    providers: [],
    loading: false,
    saving: false,
    error: null,
  });

  const load = useCallback(async () => {
    if (!employeeId) return;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const [view, providers] = await Promise.all([
        window.opc!.org.stack(employeeId),
        window.opc!.models.list(),
      ]);
      setState((previous) => ({ ...previous, view, providers, loading: false }));
    } catch (caught) {
      setState((previous) => ({
        ...previous,
        loading: false,
        error: caught instanceof Error ? caught.message : String(caught),
      }));
    }
  }, [employeeId]);

  useEffect(() => {
    setState({ view: null, providers: [], loading: Boolean(employeeId), saving: false, error: null });
    void load();
  }, [employeeId, load]);

  const save = useCallback(
    async (input: EmployeeStackInput) => {
      if (!employeeId) return;
      setState((previous) => ({ ...previous, saving: true, error: null }));
      try {
        const view = await window.opc!.org.setStack(employeeId, input);
        setState((previous) => ({ ...previous, view, saving: false }));
      } catch (caught) {
        setState((previous) => ({
          ...previous,
          saving: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
        throw caught;
      }
    },
    [employeeId],
  );

  const choices = useMemo(() => chatModelChoices(state.providers), [state.providers]);

  const setPolicy = useCallback(
    (policy: EmployeeToolPolicy) => save({ policy }),
    [save],
  );

  return {
    ...state,
    choices,
    reload: load,
    save,
    setPolicy,
  };
}

interface ModelChoicesState {
  choices: ModelChoice[];
  defaultModel: ModelRef | null;
  loading: boolean;
  error: string | null;
}

/**
 * The picker's data without an employee id.
 *
 * The hire wizard has no dossier yet but must offer exactly the same models as
 * the dossier's "底层模型与技能" section; centralising the fetch keeps the two
 * from drifting apart.
 */
export function useModelChoices() {
  const [state, setState] = useState<ModelChoicesState>({
    choices: [],
    defaultModel: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [providers, defaults] = await Promise.all([
          window.opc!.models.list(),
          window.opc!.models.getDefaults(),
        ]);
        if (cancelled) return;
        setState({
          choices: chatModelChoices(providers),
          defaultModel: defaults.llm,
          loading: false,
          error: null,
        });
      } catch (caught) {
        if (cancelled) return;
        setState((previous) => ({
          ...previous,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
