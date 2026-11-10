import { useState, type ReactNode } from "react";
import type { InstanceInfo } from "@/state/store";
import { J1SettingsSlot } from "./J1Settings";
import { j1Post, useJ1Navigation } from "./J1Navigation";

/** One provider picker owns both native bot accounts and J1 accounts. */
export function J1Providers({
  instances,
  renderEngine,
  extra,
}: {
  instances: InstanceInfo[];
  renderEngine: (instance: InstanceInfo, bare?: boolean) => ReactNode;
  extra: ReactNode;
}) {
  const navigation = useJ1Navigation();
  const [selection, setSelection] = useState("");
  const native = instances.filter((instance) => instance.driverKind !== "j1-deepai");
  const host = navigation?.providers ?? [];
  const options = [
    ...native.map((instance) => ({
      id: `bot:${instance.instanceId}`,
      label: `${instance.displayName} · Bots`,
    })),
    ...host.map((instance) => ({ id: `j1:${instance.id}`, label: instance.label })),
  ];
  const hostSelection = host.find((item) => item.selected)?.id;
  const selected =
    (!selection || selection.startsWith("j1:")) && hostSelection
      ? `j1:${hostSelection}`
      : selection === "j1:new" || options.some((option) => option.id === selection)
        ? selection
        : (options[0]?.id ?? "");
  const instance = native.find((one) => `bot:${one.instanceId}` === selected);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 px-4">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Model providers</h1>
        <button
          className="ml-auto rounded-lg border border-edge px-3 py-2 text-sm text-ink"
          onClick={() => {
            setSelection("j1:new");
            j1Post({ type: "provider-add" });
          }}
        >
          Add provider
        </button>
      </div>
      <div className="px-4">
        <label className="flex flex-col gap-2 text-sm text-ink">
          Provider account
          <select
            className="rounded-lg border border-edge bg-surface px-3 py-2 text-ink"
            value={selected}
            onChange={(event) => {
              const value = event.target.value;
              setSelection(value);
              if (value.startsWith("j1:"))
                j1Post({ type: "provider-select", instanceId: value.slice(3) });
            }}
          >
            {selected === "j1:new" && <option value="j1:new">New provider</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {instance && (
        <>
          {renderEngine(instance, true)}
          {extra}
        </>
      )}
      <div hidden={Boolean(instance)}>
        <J1SettingsSlot />
      </div>
    </div>
  );
}
