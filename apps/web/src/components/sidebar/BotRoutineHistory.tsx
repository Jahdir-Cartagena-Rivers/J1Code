import type { BotId, BotRoutine, EnvironmentId } from "@t3tools/contracts";
import { botRoutineHistory } from "../../state/botRoutines";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

const labels = {
  claimed: "Starting",
  admitted: "Turn requested",
  failed: "Not started",
  uncertain: "Outcome uncertain",
} as const;
export function BotRoutineHistory({
  environmentId,
  botId,
  routines,
}: {
  environmentId: EnvironmentId;
  botId: BotId;
  routines: ReadonlyArray<BotRoutine>;
}) {
  const history = useEnvironmentQuery(botRoutineHistory({ environmentId, input: { botId } }));
  return (
    <section aria-label="Routine history" className="space-y-2">
      <div className="flex items-center justify-between">
        <span>Routine history</span>
        <Button type="button" variant="ghost" size="sm" onClick={history.refresh}>
          Refresh
        </Button>
      </div>
      {history.isPending ? <p>Loading history...</p> : null}
      {history.error ? <p role="alert">Could not load routine history.</p> : null}
      {history.data?.length === 0 ? <p>No runs yet.</p> : null}
      {history.data?.map((run) => (
        <div key={`${run.routineId}:${run.occurrence}`} className="text-sm">
          {routines.find((routine) => routine.id === run.routineId)?.name ?? "Removed routine"} -{" "}
          {new Date(run.occurrence).toLocaleString()} - {labels[run.status]}
          {run.detail ? ` - ${run.detail}` : ""}
        </div>
      ))}
    </section>
  );
}
