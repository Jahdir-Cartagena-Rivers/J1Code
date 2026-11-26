import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@j1code/provider-acp-registry/server";
import { AntigravityDriver, type AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { DeepAIDriver, type DeepAIDriverEnv } from "./Drivers/DeepAIDriver.ts";
import { CursorDriver, type CursorDriverEnv } from "./Drivers/CursorInteractiveDriver.ts";
import { FxDriver, type FxDriverEnv } from "@j1code/provider-fx/server";
import { GrokDriver, type GrokDriverEnv } from "@j1code/provider-grok/server";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@j1code/provider-opencode/server";
import { MuseDriver, type MuseDriverEnv } from "@j1code/provider-muse/server";
import { PiDriver, type PiDriverEnv } from "@j1code/provider-pi/server";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@j1code/provider-core/server/driver";
import { KiroDriver, type KiroDriverEnv } from "@j1code/provider-kiro/server";

export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | DeepAIDriverEnv
  | FxDriverEnv
  | GrokDriverEnv
  | KiroDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv
  | MuseDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  FxDriver,
  OpenCodeDriver,
  AntigravityDriver,
  KiroDriver,
  PiDriver,
  MuseDriver,
  AcpRegistryDriver,
  DeepAIDriver,
];

export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | ProviderUsageReaderEnv<typeof PiDriver>
  | ProviderUsageReaderEnv<typeof MuseDriver>;

/** Order matters: aggregation keeps the first duplicate record. */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiDriver,
  OpenCodeDriver,
  MuseDriver,
  AntigravityDriver,
  CursorDriver,
];
