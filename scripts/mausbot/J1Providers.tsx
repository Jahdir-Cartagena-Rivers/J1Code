import { useEffect, useState, type ReactNode } from "react";
import { api, type InstanceInfo } from "@/state/store";
import { J1SettingsSlot } from "./J1Settings";
import { j1Post, useJ1Navigation } from "./J1Navigation";
import { J1SettingsPicker } from "./J1SettingsPicker";

/** One provider picker owns both native bot accounts and J1 accounts. */
export function J1Providers({
  instances,
  renderEngine,
  extra,
  refresh,
}: {
  instances: InstanceInfo[];
  renderEngine: (instance: InstanceInfo, bare?: boolean) => ReactNode;
  extra: ReactNode;
  refresh?: ReactNode;
}) {
  const navigation = useJ1Navigation();
  const [selection, setSelection] = useState("");
  const [sharedIds, setSharedIds] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    if (!navigation || !instances.length) return;
    void api<Array<{ nativeId: string }>>("/api/j1/provider-links").then(
      (links) => {
        if (current && Array.isArray(links)) setSharedIds(links.map((link) => link.nativeId));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [navigation, instances]);
  const native = instances.filter(
    (instance) =>
      !["j1-deepai", "j1-shared"].includes(instance.driverKind) &&
      !sharedIds.includes(instance.instanceId),
  );
  const host = navigation?.providers ?? [];
  const options = [
    ...host.map((instance) => ({ id: `j1:${instance.id}`, label: instance.label })),
    ...native.map((instance) => ({
      id: `bot:${instance.instanceId}`,
      label: `${instance.displayName} · Native account`,
    })),
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
        <div className="ml-auto" onClick={() => j1Post({ type: "provider-refresh" })}>
          {refresh}
        </div>
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
          <J1SettingsPicker
            aria-label="Provider account"
            value={selected}
            onSelect={(value) => {
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
          </J1SettingsPicker>
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
