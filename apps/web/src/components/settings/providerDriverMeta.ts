import { createElement } from "react";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import type { ProviderDriverKind } from "@j1code/contracts";
import { providerClients } from "@j1code/client-runtime/provider-clients";
import type { ProviderClientDefinition as RegistryProviderClientDefinition } from "@j1code/provider-core/client";
import {
  AntigravityIcon, ClaudeAI, CursorIcon, DeepAIIcon, type Icon, OpenAI,
} from "../Icons";

export { providerClients };

const legacyIcons: Readonly<Record<string, Icon>> = {
  codex: OpenAI, claudeAgent: ClaudeAI, cursor: CursorIcon,
  antigravity: AntigravityIcon, deepai: DeepAIIcon,
};

export type ProviderClientDefinition = Omit<RegistryProviderClientDefinition, "driverKind" | "icon"> & {
  readonly value: ProviderDriverKind;
  readonly icon?: Icon;
};

export const DRIVER_OPTIONS: readonly ProviderClientDefinition[] = providerClients.definitions.map(
  ({ driverKind, icon, ...definition }) => ({
    ...definition, value: driverKind, icon: legacyIcons[driverKind] ?? (icon === undefined ? undefined : (props) =>
      createElement(ProviderPackageIcon, { ...props, icon })),
  }),
);
export const DRIVER_OPTION_BY_VALUE: Partial<Record<ProviderDriverKind, ProviderClientDefinition>> =
  Object.fromEntries(DRIVER_OPTIONS.map(definition => [definition.value, definition]));
export type DriverOption = ProviderClientDefinition;

export function getDriverOption(driver: ProviderDriverKind | undefined): DriverOption | undefined {
  return driver === undefined ? undefined : DRIVER_OPTIONS.find(option => option.value === driver);
}
