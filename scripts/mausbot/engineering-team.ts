import { parse } from "yaml";
import { z } from "zod";
import type { Store } from "./store.ts";
import type { TeamSetupOperation } from "../shared/team-setup.ts";
import { engineeringSource } from "./j1-engineering-blueprint.ts";

const blueprint = z
  .object({
    agents: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        title: z.string(),
        description: z.string(),
        playbooks: z.array(z.string()),
      }),
    ),
    playbooks: z.array(z.object({ key: z.string(), name: z.string(), instructions: z.string() })),
  })
  .parse(parse(engineeringSource.split("---")[1] ?? ""));
const department = "Engineering";
const roomId = "j1-engineering-room";
const roleId = (key: string) => `j1-engineering-${key}`;
const policy = `You belong to one shared engineering department covering the user's projects. Ada leads the department, Lin owns backend work, Pixel owns client work, and Rigel owns QA and release verification. Work directly in your own bot threads using J1's shared execution and the selected project's context. Keep each task's project, owner, evidence and permissions explicit. Reuse the existing owner and conversation before starting duplicate work. Use the Engineering Room for coordination and return results or questions to the originating conversation. Head Admin is the general manager across the broader operation and an optional contact; engineering does not require Head Admin's day-to-day orders. Preserve real approval requirements and existing histories. Delegate only useful bounded work, not every task. A role name does not grant authority to publish, install, delete data or bypass permissions.`;

export function setupEngineeringTeam(store: Store, leadBotId: string) {
  const lead = store.bot(leadBotId);
  if (!lead) throw new Error("Select the existing project builder to become the engineering lead.");
  if (lead.modelSelection.instanceId !== "j1-shared")
    throw new Error("Select a J1 shared provider for the lead before setting up the team.");
  if (lead.busy || store.bots.some((bot) => bot.section === department && bot.busy))
    throw new Error("Wait for the department's active work to finish before changing its setup.");
  const existingRoom = store.groups.find((group) => group.id === roomId);
  if (existingRoom && !existingRoom.memberIds.includes(lead.id))
    throw new Error("The engineering department already has a different lead.");
  const ids = [
    lead.id,
    ...blueprint.agents.filter((agent) => agent.key !== "ada").map((agent) => roleId(agent.key)),
  ];
  if (existingRoom && ids.every((id) => store.bot(id)))
    return { ready: true, leadBotId, roomId, botIds: ids };
  const operations: TeamSetupOperation[] = [];
  for (const agent of blueprint.agents) {
    const id = agent.key === "ada" ? lead.id : roleId(agent.key);
    const existing = store.bot(id);
    if (existing && agent.key !== "ada") {
      if (existing.section !== department)
        throw new Error(
          "An engineering role identifier is already in use; its history was preserved.",
        );
      continue;
    }
    const playbooks = blueprint.playbooks
      .filter((book) => agent.playbooks.includes(book.key))
      .map((book) => `${book.name}\n${book.instructions}`)
      .join("\n\n");
    const instructions = [agent.description, policy, playbooks].join("\n\n");
    const soul =
      agent.key === "ada"
        ? lead.soul?.includes("## Engineering department")
          ? lead.soul
          : `${lead.soul ?? ""}\n\n## Engineering department\n${instructions}`
        : instructions;
    if (Buffer.byteLength(soul, "utf8") > 24_000)
      throw new Error(
        "The lead's saved instructions need more room before the engineering role can be added; nothing was changed.",
      );
    operations.push({
      action: existing ? "update" : "create",
      botId: id,
      ...(!existing ? { threadId: `${id}-main` } : {}),
      fields: {
        name: agent.name,
        title: agent.key === "ada" ? "Engineering Lead · J1 Project Builder" : agent.title,
        description: agent.description,
        soul,
        section: department,
        chiefOfStaff: agent.key === "ada",
        ...(!existing ? { modelSelection: structuredClone(lead.modelSelection) } : {}),
      },
    });
  }
  if (operations.length)
    store.applyTeamSetup({
      version: 1,
      requestId: `j1-engineering-v1:${lead.id}`,
      botId: lead.id,
      threadId: lead.threadId,
      reason:
        "Set up the engineering department and retain the existing project builder as its lead.",
      createdAt: Date.now(),
      requesterRevision: "j1-engineering-v1",
      operations,
      newTeams: [],
    });
  const room =
    existingRoom ??
    store.createGroup("Engineering Room", ids, false, department, {
      id: roomId,
      threadId: `${roomId}-main`,
      bulletin: policy,
      defaultResponder: { kind: "member", botId: lead.id },
      completed: true,
    });
  if (existingRoom) store.patchGroup(room.id, { memberIds: ids });
  return { ready: true, leadBotId, roomId: room.id, botIds: ids };
}
