import * as Schema from "effect/Schema";
import {
  ManualRouteActionError,
  ManualRouteConfirmInput,
  ManualRoutePrepareInput,
  ManualRouteListInput,
  ManualRouteStatusInput,
} from "@t3tools/contracts";
import type { makeManualRouteBoundary } from "./manualRouteBoundary.ts";

const decodePrepare = Schema.decodeUnknownSync(ManualRoutePrepareInput, {
  onExcessProperty: "error",
});
const decodeList = Schema.decodeUnknownSync(ManualRouteListInput, { onExcessProperty: "error" });
const decodeConfirm = Schema.decodeUnknownSync(ManualRouteConfirmInput, {
  onExcessProperty: "error",
});
const decodeStatus = Schema.decodeUnknownSync(ManualRouteStatusInput, {
  onExcessProperty: "error",
});

/** UI RPC adapter. The server constructs a boundary for each authenticated connection. */
export function makeManualRouteRpc(boundary: ReturnType<typeof makeManualRouteBoundary> | null) {
  const requireBoundary = () => {
    if (!boundary)
      throw new ManualRouteActionError({
        code: "unavailable",
        message: "Manual routing authority is not integrated.",
      });
    return boundary;
  };
  const decode = <A>(parse: () => A): A => {
    try {
      return parse();
    } catch {
      throw new ManualRouteActionError({
        code: "invalid-input",
        message: "Invalid route action input.",
      });
    }
  };
  const invoke = async <A>(action: () => Promise<A>) => {
    try {
      return await action();
    } catch (cause) {
      if (Schema.is(ManualRouteActionError)(cause)) throw cause;
      // Do not expose route existence, SQL failures or endpoint access details.
      throw new ManualRouteActionError({
        code: "rejected",
        message: "Route action rejected; prepare again after refreshing.",
      });
    }
  };
  return {
    list: (input: unknown) =>
      invoke(async () => requireBoundary().list(decode(() => decodeList(input)).source)),
    prepare: (input: unknown) =>
      invoke(async () => {
        const trusted = requireBoundary();
        const value = decode(() => decodePrepare(input));
        return trusted.prepare(value.requestId, value.source, value.destination);
      }),
    confirm: (input: unknown) =>
      invoke(async () => {
        const trusted = requireBoundary();
        const value = decode(() => decodeConfirm(input));
        const result = await trusted.confirm(value.token);
        // Return no content, permission sets or persisted internal state.
        return { revision: result.revision };
      }),
    status: (input: unknown) =>
      invoke(async () => {
        const trusted = requireBoundary();
        const value = decode(() => decodeStatus(input));
        return trusted.status(value.requestId, value.source);
      }),
  };
}
