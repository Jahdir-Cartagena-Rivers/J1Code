import type { BotId, BotRoutine, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { botRoutineHistory } from "../../state/botRoutines";
import { useEnvironmentQuery } from "../../state/query";
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
    <View className="gap-2">
      <AppText>Routine history</AppText>
      <MaterialButton label="Refresh history" onPress={history.refresh} />
      {history.isPending ? <AppText>Loading history...</AppText> : null}
      {history.error ? (
        <AppText accessibilityRole="alert">Could not load routine history.</AppText>
      ) : null}
      {history.data?.length === 0 ? <AppText>No runs yet.</AppText> : null}
      {history.data?.map((run) => (
        <AppText key={`${run.routineId}:${run.occurrence}`}>
          {routines.find((routine) => routine.id === run.routineId)?.name ?? "Removed routine"} -{" "}
          {new Date(run.occurrence).toLocaleString()} - {labels[run.status]}
          {run.detail ? ` - ${run.detail}` : ""}
        </AppText>
      ))}
    </View>
  );
}
