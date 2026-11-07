import type { BotRoutine } from "@t3tools/contracts";
import { Switch, TextInput, View } from "react-native";
import { AppText } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { MaterialButton } from "../../components/MaterialButton";
import { uuidv4 } from "../../lib/uuid";

export function BotRoutinesEditor({
  routines,
  onChange,
}: {
  routines: ReadonlyArray<BotRoutine>;
  onChange: (routines: ReadonlyArray<BotRoutine>) => void;
}) {
  const update = (id: string, edit: (routine: BotRoutine) => BotRoutine) =>
    onChange(routines.map((routine) => (routine.id === id ? edit(routine) : routine)));
  return (
    <View className="gap-3">
      <AppText className="font-t3-medium">Routines</AppText>
      {routines.map((routine) => {
        const at =
          routine.schedule.type === "once" ? routine.schedule.at : routine.schedule.anchorAt;
        return (
          <View key={routine.id} className="gap-2 rounded-lg border border-border p-3">
            <AppText>Routine name</AppText>
            <TextInput
              accessibilityLabel="Routine name"
              className="rounded-lg border border-border p-3 text-foreground"
              value={routine.name}
              maxLength={120}
              onChangeText={(name) => update(routine.id, (old) => ({ ...old, name }))}
            />
            <AppText>What should the bot do?</AppText>
            <TextInput
              accessibilityLabel="Routine instructions"
              className="rounded-lg border border-border p-3 text-foreground"
              value={routine.prompt}
              maxLength={32000}
              multiline
              onChangeText={(prompt) => update(routine.id, (old) => ({ ...old, prompt }))}
            />
            <ControlPillMenu
              title="Schedule"
              actions={[
                { id: "once", title: "Once" },
                { id: "interval", title: "Repeat at an interval" },
              ]}
              onPressAction={({ nativeEvent }) =>
                update(routine.id, (old) => ({
                  ...old,
                  schedule:
                    nativeEvent.event === "interval"
                      ? { type: "interval", anchorAt: at, everyMinutes: 1440 }
                      : { type: "once", at },
                }))
              }
            >
              <ControlPill
                label={routine.schedule.type === "once" ? "Once" : "Repeat at an interval"}
                accessibilityLabel="Routine schedule"
                variant="pill"
              />
            </ControlPillMenu>
            <AppText>Start time (UTC, for example 2026-12-01T09:00:00Z)</AppText>
            <TextInput
              accessibilityLabel="Routine start time UTC"
              className="rounded-lg border border-border p-3 text-foreground"
              value={at}
              autoCapitalize="characters"
              onChangeText={(value) =>
                update(routine.id, (old) => ({
                  ...old,
                  schedule:
                    old.schedule.type === "once"
                      ? { ...old.schedule, at: value }
                      : { ...old.schedule, anchorAt: value },
                }))
              }
            />
            {routine.schedule.type === "interval" ? (
              <>
                <AppText>Repeat every (minutes)</AppText>
                <TextInput
                  accessibilityLabel="Routine interval minutes"
                  className="rounded-lg border border-border p-3 text-foreground"
                  keyboardType="number-pad"
                  value={String(routine.schedule.everyMinutes)}
                  onChangeText={(value) =>
                    update(routine.id, (old) =>
                      old.schedule.type === "interval"
                        ? { ...old, schedule: { ...old.schedule, everyMinutes: Number(value) } }
                        : old,
                    )
                  }
                />
              </>
            ) : null}
            <View className="flex-row items-center justify-between">
              <AppText>Enabled</AppText>
              <Switch
                accessibilityLabel="Routine enabled"
                value={routine.enabled}
                onValueChange={(enabled) => update(routine.id, (old) => ({ ...old, enabled }))}
              />
            </View>
            <MaterialButton
              label="Remove routine"
              onPress={() => onChange(routines.filter((old) => old.id !== routine.id))}
            />
          </View>
        );
      })}
      <MaterialButton
        label="Add routine"
        disabled={routines.length >= 50}
        onPress={() =>
          onChange([
            ...routines,
            {
              id: uuidv4(),
              name: "",
              prompt: "",
              enabled: true,
              schedule: { type: "once", at: new Date(Date.now() + 3600000).toISOString() },
            },
          ])
        }
      />
      <AppText>Routines run while this J1 server is running.</AppText>
    </View>
  );
}
