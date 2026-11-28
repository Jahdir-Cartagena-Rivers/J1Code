import type { EnvironmentId, ProviderInstanceId, RuntimeMode } from "@j1code/contracts";
import { useAtomValue } from "@effect/atom-react";

import { shortcutLabelForCommand } from "../keybindings";
import { useManagedPolicy } from "../state/managedPolicy";
import {
  RuntimeModeLimitsTargetContext,
  runtimeModeLimitsTarget,
  useProviderRuntimeModeLimits,
} from "../state/runtimeModeLimits";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { ComposerPermissionsSection } from "./chat/ComposerFooterControls";
import { useComposerMenuProps } from "./chat/composerEventScope";
import {
  resolveCompatibleRuntimeMode,
  resolveRuntimeModeOptions,
  runtimeModeConfig,
} from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ComposerContextPermissions(props: {
  environmentId: EnvironmentId | null;
  runtimeMode: RuntimeMode;
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  /** The one provider this draft sends to and its folder; undefined for a multi-model send. */
  instanceId: ProviderInstanceId | undefined;
  cwd: string | null;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const { mode, modes } = resolveCompatibleRuntimeMode(
    props.runtimeMode,
    props.supportedRuntimeModes,
  );
  const limitsFor = runtimeModeLimitsTarget(props.environmentId, props.instanceId, props.cwd);
  const options = resolveRuntimeModeOptions(
    modes,
    useManagedPolicy(props.environmentId),
    useProviderRuntimeModeLimits(limitsFor),
  );
  const composerMenuProps = useComposerMenuProps();
  const { icon: Icon, label } = runtimeModeConfig[mode];
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  size="xs"
                  className="ms-auto min-w-0 shrink-0"
                  aria-label={`Permissions: ${label}`}
                  data-composer-context-control
                />
              }
            />
          }
        >
          <Icon aria-hidden="true" className="size-3" />
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>Permissions{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" {...composerMenuProps}>
        <RuntimeModeLimitsTargetContext value={limitsFor}>
          <ComposerPermissionsSection
            runtimeMode={mode}
            runtimeModeOptions={options}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        </RuntimeModeLimitsTargetContext>
      </MenuPopup>
    </Menu>
  );
}
