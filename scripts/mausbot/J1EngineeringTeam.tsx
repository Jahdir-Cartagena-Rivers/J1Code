import { useState } from "react";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { Field } from "./bot-settings/field";

export function J1EngineeringTeam({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const { request, draft } = useBotEditor();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (
    draft ||
    !state.config?.j1Managed ||
    !(
      /J1.*Project Builder/i.test(bot.name) ||
      (bot.name === "Ada" && bot.section === "Engineering")
    )
  )
    return null;
  return (
    <Field label="Engineering department">
      <p className="mb-2 text-[13px] text-ink-secondary">
        Keep this bot's conversations as Ada, the engineering lead, and add Lin, Pixel, Rigel and
        their Engineering Room. Head Admin remains the general manager.
      </p>
      <button
        type="button"
        aria-label="Set up engineering team"
        className="rounded-md px-3 py-2 text-[13px] font-medium text-accent-text hover:bg-accent/10"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage("");
          void request("/api/j1/engineering", {
            method: "POST",
            body: JSON.stringify({ leadBotId: bot.id }),
          })
            .then(
              () =>
                setMessage(
                  "The engineering department is ready. Existing conversations are preserved.",
                ),
              (error) => setMessage(String(error)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Setting up…" : "Set up engineering team"}
      </button>
      {message && (
        <p role="status" className="mt-2 text-[13px]">
          {message}
        </p>
      )}
    </Field>
  );
}
