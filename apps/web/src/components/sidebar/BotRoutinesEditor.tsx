import type { BotRoutine } from "@t3tools/contracts";
import { newBotId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

function localTime(iso: string): string {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

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
    <section className="space-y-3" aria-label="Bot routines">
      <div className="flex items-center justify-between">
        <span>Routines</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={routines.length >= 50}
          onClick={() =>
            onChange([
              ...routines,
              {
                id: newBotId(),
                name: "",
                prompt: "",
                enabled: true,
                schedule: { type: "once", at: new Date(Date.now() + 3600000).toISOString() },
              },
            ])
          }
        >
          Add routine
        </Button>
      </div>
      {routines.map((routine) => {
        const at =
          routine.schedule.type === "once" ? routine.schedule.at : routine.schedule.anchorAt;
        return (
          <div key={routine.id} className="space-y-2 rounded-md border p-3">
            <label className="grid gap-1">
              Routine name
              <Input
                value={routine.name}
                maxLength={120}
                onChange={(event) =>
                  update(routine.id, (old) => ({ ...old, name: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1">
              What should the bot do?
              <Textarea
                value={routine.prompt}
                maxLength={32000}
                onChange={(event) =>
                  update(routine.id, (old) => ({ ...old, prompt: event.target.value }))
                }
              />
            </label>
            <label className="grid gap-1">
              Schedule
              <select
                className="rounded border bg-background p-2"
                value={routine.schedule.type}
                onChange={(event) =>
                  update(routine.id, (old) => ({
                    ...old,
                    schedule:
                      event.target.value === "interval"
                        ? { type: "interval", anchorAt: at, everyMinutes: 1440 }
                        : { type: "once", at },
                  }))
                }
              >
                <option value="once">Once</option>
                <option value="interval">Repeat at an interval</option>
              </select>
            </label>
            <label className="grid gap-1">
              {routine.schedule.type === "once" ? "Run at" : "Start at"}
              <Input
                type="datetime-local"
                value={localTime(at)}
                onChange={(event) => {
                  const value = new Date(event.target.value);
                  if (!Number.isFinite(value.getTime())) return;
                  update(routine.id, (old) => ({
                    ...old,
                    schedule:
                      old.schedule.type === "once"
                        ? { ...old.schedule, at: value.toISOString() }
                        : { ...old.schedule, anchorAt: value.toISOString() },
                  }));
                }}
              />
            </label>
            {routine.schedule.type === "interval" ? (
              <label className="grid gap-1">
                Repeat every (minutes)
                <Input
                  type="number"
                  min={1}
                  max={525600}
                  value={routine.schedule.everyMinutes}
                  onChange={(event) => {
                    const minutes = Number(event.target.value);
                    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) return;
                    update(routine.id, (old) =>
                      old.schedule.type === "interval"
                        ? { ...old, schedule: { ...old.schedule, everyMinutes: minutes } }
                        : old,
                    );
                  }}
                />
              </label>
            ) : null}
            <div className="flex items-center justify-between">
              <label>
                <input
                  type="checkbox"
                  checked={routine.enabled}
                  onChange={(event) =>
                    update(routine.id, (old) => ({ ...old, enabled: event.target.checked }))
                  }
                />{" "}
                Enabled
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange(routines.filter((old) => old.id !== routine.id))}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Routines run while this J1 server is running. Times use this device's time zone.
      </p>
    </section>
  );
}
