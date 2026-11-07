// Data and navigation stay with the original Mausbot store/search implementation.
import { useEffect, useLayoutEffect, useRef } from "react";
import { api, openBot, useStore, visibleMessages } from "@/state/store";
import { botPreview } from "./sidebar-preview";
import { rankByName } from "@/lib/palette-rank";
import { useShowThreads } from "@/lib/thread-preferences";
import { useAdvancedMode } from "@/lib/interface-mode";
import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { j1Post } from "./J1Navigation";

export function J1SearchBridge() {
  const { state, dispatch } = useStore();
  const threads = useShowThreads();
  const advanced = useAdvancedMode();
  const latest = useRef({ state, threads, advanced });
  useLayoutEffect(() => {
    latest.current = { state, threads, advanced };
  }, [state, threads, advanced]);
  useEffect(() => {
    const origin = new URLSearchParams(location.hash.slice(1)).get("j1-origin");
    if (!origin || parent === window) return;
    const targets = new Map<string, () => Promise<void>>();
    let generation = "";
    let live = true;
    const receive = (event: MessageEvent) => {
      if (
        event.origin !== origin ||
        event.source !== parent ||
        event.data?.source !== "j1-host" ||
        event.data.type !== "search-call"
      )
        return;
      const { requestId, method, input } = event.data;
      if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId)) return;
      const respond = (value?: unknown, error?: string) => {
        if (live)
          parent.postMessage(
            { source: "j1-mausbot", type: "search-result", requestId, value, error },
            origin,
          );
      };
      const run = async () => {
        if (method === "land" && typeof input === "string") {
          const target = targets.get(input);
          if (!target) throw new Error("These results changed. Search again.");
          j1Post({ type: "native" });
          await target();
          respond(true);
          return;
        }
        if (method !== "search" || typeof input !== "string" || input.length > 1000)
          throw new Error("Invalid search request.");
        generation = requestId;
        const q = input.trim().toLowerCase();
        const snapshot = latest.current;
        const visibleBots = snapshot.state.bots.filter((bot) => !bot.hidden);
        const names = rankByName(visibleBots, q);
        const nameIds = new Set(names.map((bot) => bot.id));
        const extra = visibleBots.filter(
          (bot) =>
            !nameIds.has(bot.id) &&
            ((bot.title ?? "").toLowerCase().includes(q) ||
              botPreview(bot, visibleMessages(bot), snapshot.state.instances, snapshot.advanced)
                .toLowerCase()
                .includes(q) ||
              bot.tasks?.some(
                (task) => !task.routineRunId && task.title.toLowerCase().includes(q),
              ) ||
              bot.projects?.some((folder) => folder.name.toLowerCase().includes(q))),
        );
        const bots = [...names, ...extra].slice(0, 12);
        const rooms = rankByName(snapshot.state.groups, q).slice(0, 8);
        const response =
          q.length >= 2
            ? await api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=20`)
            : { hits: [] };
        if (generation !== requestId) throw new Error("Search superseded.");
        targets.clear();
        const rows: {
          key: string;
          kind: "bot" | "room" | "message";
          title: string;
          description: string;
        }[] = [];
        for (const bot of bots) {
          const key = `${requestId}:bot:${bot.id}`;
          rows.push({
            key,
            kind: "bot",
            title: bot.name.slice(0, 200),
            description: (bot.title || "Bot").slice(0, 400),
          });
          targets.set(key, async () => {
            const current = latest.current.state.bots.find((item) => item.id === bot.id);
            if (!current) throw new Error("This bot is no longer available.");
            openBot(dispatch, current, latest.current.threads);
          });
        }
        for (const group of rooms) {
          const key = `${requestId}:room:${group.id}`;
          rows.push({
            key,
            kind: "room",
            title: group.name.slice(0, 200),
            description: "Bot room",
          });
          targets.set(key, async () => {
            if (!latest.current.state.groups.some((item) => item.id === group.id))
              throw new Error("This room is no longer available.");
            dispatch({ type: "select", id: group.id });
          });
        }
        for (const hit of response.hits.slice(0, 20)) {
          const key = `${requestId}:message:${rows.length}`;
          rows.push({
            key,
            kind: "message",
            title: [hit.from || hit.name, hit.task].filter(Boolean).join(" · ").slice(0, 200),
            description: hit.snippet.slice(0, 400),
          });
          targets.set(key, () =>
            landOnSearchHit(hit, latest.current.state, dispatch, latest.current.threads),
          );
        }
        respond(rows);
      };
      void run().catch((error) =>
        respond(
          undefined,
          error instanceof Error ? error.message.slice(0, 300) : "Bot search failed.",
        ),
      );
    };
    window.addEventListener("message", receive);
    return () => {
      live = false;
      targets.clear();
      window.removeEventListener("message", receive);
    };
  }, [dispatch]);
  return null;
}
