import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderRuntimeModeLimit,
} from "@j1code/contracts";
import { createContext, useEffect } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

interface RuntimeModeLimitsTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}

const NO_LIMITS: ReadonlyArray<ProviderRuntimeModeLimit> = [];

/** The folder and provider whose limits an open mode picker should check again. */
export const RuntimeModeLimitsTargetContext = createContext<RuntimeModeLimitsTarget | null>(null);

export function runtimeModeLimitsTarget(
  environmentId: EnvironmentId | null,
  instanceId: ProviderInstanceId | undefined,
  cwd: string | null,
): RuntimeModeLimitsTarget | null {
  return environmentId && instanceId && cwd ? { environmentId, instanceId, cwd } : null;
}

/**
 * Modes the provider offers that cannot run in `target`'s folder. Empty until the server
 * answers and when it cannot, so a mode is only ever marked on a known reason. `mountScope`
 * refreshes the server response when the picker opens.
 */
export function useProviderRuntimeModeLimits(
  target: RuntimeModeLimitsTarget | null,
  mountScope?: "picker",
): ReadonlyArray<ProviderRuntimeModeLimit> {
  const query =
    target === null
      ? null
      : serverEnvironment.providerRuntimeModeLimits({
          environmentId: target.environmentId,
          input: { instanceId: target.instanceId, cwd: target.cwd },
        });
  const { data, refresh } = useEnvironmentQuery(query);
  // oxlint-disable-next-line j1code/no-unreasoned-state-sync -- Opening the picker refreshes the remote provider configuration.
  useEffect(() => {
    if (query !== null && mountScope === "picker") refresh();
  }, [query, mountScope, refresh]);
  return data?.limits ?? NO_LIMITS;
}
