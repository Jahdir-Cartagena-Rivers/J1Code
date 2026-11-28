import { ProjectId, ProviderInstanceId } from "@j1code/contracts";
import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Seed native enrollment fixtures outside the runtime reader.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Create fixtures with native paths for the Promise reader.
import * as NodePath from "node:path";
import {
  ownedNativeRoomProject,
  readNativeBotEnrollmentSnapshot,
  readNativeRoomMemberEnrollment,
  roomProviderSystem,
  stageColdNativeRoomAttachments,
  stageNativeBotEnrollment,
  validateColdNativeRoomTurn,
} from "./NativeBotEnrollment.ts";

const saved = {
  botId: "native-bot",
  threadId: "native-thread",
  name: "Original bot",
  description: "Saved role",
  instructions: "Saved instructions",
  projectId: "profile-project",
  threadProjectId: "thread-project",
  modelSelection: { instanceId: "profile-account", model: "profile-model" },
  threadSelection: { instanceId: "thread-account", model: "thread-model" },
  approvalMode: "ask",
  restrictedTools: true,
};

describe("private native bot enrollment read", () => {
  it("accepts continuation data only from the requested private read and for the exact owner", () => {
    const resume = {
      ...saved,
      savedResumeCursor: "j1-shared:v2:native-bot:native-thread:policy:run:original",
    };
    expect(readNativeBotEnrollmentSnapshot(resume, saved.botId, saved.threadId, true)).toEqual(
      resume,
    );
    expect(() => readNativeBotEnrollmentSnapshot(resume, saved.botId, saved.threadId)).toThrow();
    expect(() => readNativeBotEnrollmentSnapshot(resume, saved.botId, "different", true)).toThrow();
    expect(() =>
      readNativeBotEnrollmentSnapshot(saved, saved.botId, saved.threadId, true),
    ).toThrow();
  });

  it("preserves profile and thread choices independently", () => {
    expect(readNativeBotEnrollmentSnapshot(saved, "native-bot", "native-thread")).toEqual(saved);
    expect(readNativeBotEnrollmentSnapshot(null, "native-bot", "native-thread")).toBeNull();
  });

  it("rejects a different owner and credential-shaped or authority fields", () => {
    expect(() => readNativeBotEnrollmentSnapshot(saved, "foreign-bot", "native-thread")).toThrow();
    expect(() => readNativeBotEnrollmentSnapshot(saved, "native-bot", "foreign-thread")).toThrow();
    expect(() =>
      readNativeBotEnrollmentSnapshot(
        { ...saved, profileId: "foreign", credential: "fixture-value" },
        "native-bot",
        "native-thread",
      ),
    ).toThrow();
    expect(() =>
      readNativeBotEnrollmentSnapshot(
        { ...saved, threadSelection: { ...saved.threadSelection, model: "" } },
        "native-bot",
        "native-thread",
      ),
    ).toThrow();
  });
});

it("stages only owned native attachment bytes under deterministic J1 IDs", async () => {
  const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-native-history-"));
  const src = NodePath.join(sandbox, "native");
  const dest = NodePath.join(sandbox, "j1");
  try {
    await NodeFSP.mkdir(src);
    await NodeFSP.writeFile(NodePath.join(src, "owned.txt"), "old");
    const file = {
      filename: "owned.txt",
      name: "Saved filename.txt",
      mime: "text/plain",
      type: "file",
    };
    const row = {
      nativeMessageId: "prior",
      createdAt: "2026-01-02T00:00:00.000Z",
      completedAt: null,
      text: "Previous message",
      role: "user",
      attachments: [file],
    };
    const snapshot = {
      ...saved,
      nativeHistory: {
        turnId: "turn",
        anchorMessageId: "active",
        promptText: "Clean new message",
        promptAttachments: [],
        messages: [row],
      },
    };
    const stage = (value: unknown, current = () => true) =>
      stageNativeBotEnrollment(
        value,
        saved.botId,
        saved.threadId,
        src,
        {
          turnId: "turn",
          attachmentsDir: dest,
        },
        current,
      );
    const first = await stage(snapshot);
    expect(await stage(snapshot)).toEqual(first);
    expect(first?.coldHistory?.messages[0]?.attachments[0]).toMatchObject({
      name: "Saved filename.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    });
    await NodeFSP.writeFile(NodePath.join(src, "owned.txt"), "new");
    const second = await stage(snapshot);
    expect(second?.coldHistory?.messages[0]?.attachments[0]?.id).not.toEqual(
      first?.coldHistory?.messages[0]?.attachments[0]?.id,
    );
    await expect(stage(snapshot, () => false)).rejects.toThrow();
    await expect(
      stage({
        ...snapshot,
        nativeHistory: {
          ...snapshot.nativeHistory,
          messages: [{ ...row, nativeMessageId: "active" }],
        },
      }),
    ).rejects.toThrow();
    await expect(
      stage({
        ...snapshot,
        nativeHistory: {
          ...snapshot.nativeHistory,
          messages: [{ ...row, createdAt: "yesterday" }],
        },
      }),
    ).rejects.toThrow();
    await expect(
      stage({
        ...snapshot,
        nativeHistory: {
          ...snapshot.nativeHistory,
          messages: [{ ...row, attachments: [{ ...file, filename: "../owned.txt" }] }],
        },
      }),
    ).rejects.toThrow();
  } finally {
    await NodeFSP.rm(sandbox, { recursive: true, force: true });
  }
});

it("stages a saved project file and refuses escapes without breaking managed attachments", async () => {
  const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-workspace-history-"));
  const source = NodePath.join(sandbox, "attachments");
  const dest = NodePath.join(sandbox, "j1");
  const workspace = NodePath.join(sandbox, "task");
  const foreign = NodePath.join(sandbox, "neighbor");
  const nested = NodePath.join(workspace, "reports");
  const botWorkspace = NodePath.join(sandbox, "workspaces", saved.botId);
  try {
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(nested, { recursive: true });
    await NodeFSP.mkdir(botWorkspace, { recursive: true });
    await NodeFSP.mkdir(foreign);
    await NodeFSP.writeFile(NodePath.join(source, "keep.txt"), "managed");
    await NodeFSP.writeFile(NodePath.join(nested, "note.txt"), "workspace");
    await NodeFSP.writeFile(NodePath.join(nested, "bad.png"), "not a png");
    await NodeFSP.writeFile(NodePath.join(botWorkspace, "bot.txt"), "bot");
    await NodeFSP.writeFile(NodePath.join(foreign, "secret.txt"), "foreign");
    await NodeFSP.symlink(foreign, NodePath.join(workspace, "escape"), "junction");
    await NodeFSP.symlink(nested, NodePath.join(workspace, "inside"), "junction");
    const workspaceFile = {
      root: "workspace",
      filename: "reports/note.txt",
      name: "Original Name.txt",
      mime: "text/plain",
      type: "file",
    };
    const managedFile = {
      ...workspaceFile,
      root: "managed",
      filename: "keep.txt",
      name: "Keep.txt",
    };
    const botFile = { ...workspaceFile, root: "bot", filename: "bot.txt", name: "Bot.txt" };
    const row = {
      nativeMessageId: "prior",
      createdAt: "2026-01-02T00:00:00.000Z",
      completedAt: null,
      text: "Previous message",
      role: "user",
    };
    const current = () => true;
    const snapshot = (attachments: readonly unknown[], workspaceRoot = workspace) => ({
      ...saved,
      nativeHistory: {
        turnId: "turn",
        anchorMessageId: "active",
        promptText: "Clean",
        workspaceRoot,
        promptAttachments: [],
        messages: [{ ...row, attachments }],
      },
    });
    const scope = { projectId: ProjectId.make(saved.threadProjectId), root: workspace };
    const stage = (value: unknown, binding = scope, owner = current) =>
      stageNativeBotEnrollment(
        value,
        saved.botId,
        saved.threadId,
        source,
        {
          turnId: "turn",
          attachmentsDir: dest,
          workspace: binding,
        },
        owner,
      );
    const trusted = snapshot([workspaceFile, managedFile, botFile]);
    const first = await stage(trusted);
    expect(await stage(trusted)).toEqual(first);
    expect(
      first?.coldHistory?.messages[0]?.attachments.map((file) => [file.name, file.sizeBytes]),
    ).toEqual([
      ["Original Name.txt", 9],
      ["Keep.txt", 7],
      ["Bot.txt", 3],
    ]);
    await NodeFSP.writeFile(NodePath.join(nested, "note.txt"), "new-bytes");
    const updated = await stage(trusted);
    expect(updated?.coldHistory?.messages[0]?.attachments[0]?.id).not.toEqual(
      first?.coldHistory?.messages[0]?.attachments[0]?.id,
    );
    expect(updated?.coldHistory?.messages[0]?.attachments[1]?.id).toEqual(
      first?.coldHistory?.messages[0]?.attachments[1]?.id,
    );
    const inside = await stage(snapshot([{ ...workspaceFile, filename: "inside/note.txt" }]));
    expect(inside?.coldHistory?.messages[0]?.attachments[0]?.sizeBytes).toBe(9);
    await expect(stage(snapshot([workspaceFile], foreign))).rejects.toThrow();
    await expect(
      stage(trusted, { ...scope, projectId: ProjectId.make("foreign") }),
    ).rejects.toThrow();
    await expect(stage(trusted, scope, () => false)).rejects.toThrow();
    for (const filename of [
      "../neighbor/secret.txt",
      "escape/secret.txt",
      "NUL.txt",
      "reports",
      ".openmausbot-secrets/secret.txt",
    ]) {
      await expect(stage(snapshot([{ ...workspaceFile, filename }]))).rejects.toThrow();
    }
    await expect(
      stage(
        snapshot([
          { ...workspaceFile, type: "image", mime: "image/png", filename: "reports/bad.png" },
        ]),
      ),
    ).rejects.toThrow(/invalid content/);
  } finally {
    await NodeFSP.rm(sandbox, { recursive: true, force: true });
  }
});

it("requires the native room member, claimed turn and exact queued row order", async () => {
  const snapshot = {
    botId: "native-bot",
    threadId: "room-task",
    turnId: "turn",
    groupId: "room",
    dm: false,
    roster: ["native-bot", "peer"],
    enrollment: {
      name: "Original bot",
      workspace: "C:/workspace",
      selection: saved.threadSelection,
      approvalMode: "ask",
      restrictedTools: true,
    },
    operation: {
      id: "operation",
      generation: "generation",
      kind: "chat",
      requestId: "two",
      sourceRowIds: ["one", "two"],
      queuedIds: ["q1", "q2"],
      instructionsBeforeHistory: "Reply as this bot.",
      historicalInstructionText: "Previously held lines.",
      instructionsAfterHistory: "",
      renderedWindowIds: ["one", "two"],
    },
    rows: [
      {
        id: "one",
        at: 1,
        role: "user",
        kind: "text",
        text: "Relayed words",
        provenance: { authority: "information", via: "api", queueId: "q1" },
      },
      {
        id: "two",
        at: 2,
        role: "user",
        kind: "text",
        text: "Own request",
        attachments: [{ kind: "image", path: "room-image.png", mime: "image/png" }],
        provenance: { authority: "own", sender: { id: "person", name: "Person" }, queueId: "q2" },
      },
    ],
  };
  const read = (
    value: unknown = snapshot,
    bot = "native-bot",
    thread = "room-task",
    turn = "turn",
  ) => readNativeRoomMemberEnrollment(value, bot, thread, turn);
  expect(read()?.rows).toEqual(snapshot.rows);
  expect(read()?.operation).toEqual(snapshot.operation);
  const input = {
    botId: "native-bot",
    threadId: "room-task",
    turnId: "turn",
    cwd: NodePath.resolve("workspace"),
    ...saved.threadSelection,
    approvalMode: "ask",
    restrictedTools: true,
  };
  const decoded = read()!;
  const cold = {
    ...decoded,
    enrollment: { ...decoded.enrollment, workspace: input.cwd },
    operation: { ...decoded.operation, sourceRowIds: ["two"], queuedIds: [] },
  };
  const plan = validateColdNativeRoomTurn(cold, input);
  expect(plan.currentRows.map((row) => row.id)).toEqual(["two"]);
  expect(plan.historicalRows.map((row) => row.provenance.authority)).toEqual(["information"]);
  expect(String(plan.threadId)).toBe("j1-mausbot:room:room:room-task:native-bot");
  const unlabeledRequest = { ...cold.rows[1]!, provenance: { authority: "own" as const } };
  expect(
    validateColdNativeRoomTurn(
      { ...cold, rows: [cold.rows[0]!, unlabeledRequest] },
      input,
    ).currentRows.map((row) => row.id),
  ).toEqual(["two"]);
  for (const foreignOrigin of [
    { automated: true },
    { fromApp: {} },
    { webhookPost: {} },
    { handed: {} },
  ]) {
    const row = { ...cold.rows[1]!, provenance: { ...cold.rows[1]!.provenance, ...foreignOrigin } };
    expect(() =>
      validateColdNativeRoomTurn({ ...cold, rows: [cold.rows[0]!, row] }, input),
    ).toThrow(/cold person chat/);
  }
  const goal = {
    runId: "goal-run",
    cardMessageId: "goal-card",
    requestId: "two",
    coordinatorBotId: "native-bot",
    startedAt: 3,
    turnCount: 1,
    status: "working",
    goal: "Own request",
    instructions: "Coordinate the goal.\nGoal: Own request\nReport the outcome.",
  } as const;
  const goalOperation = { ...cold.operation, kind: "goal" as const, goal };
  const goalRoom = {
    ...cold,
    operation: goalOperation,
    rows: [
      cold.rows[0]!,
      { ...cold.rows[1]!, provenance: { ...cold.rows[1]!.provenance, channelMode: "goal" } },
      {
        id: "goal-card",
        at: 3,
        role: "bot",
        kind: "goal.run",
        text: "Working",
        provenance: { authority: "information", from: { botId: "native-bot" } },
      },
    ],
  } as const;
  const goalPlan = validateColdNativeRoomTurn(read(goalRoom)!, input);
  expect(goalPlan.currentRows.map((row) => row.id)).toEqual(["two"]);
  expect(goalPlan.historicalRows.map((row) => row.id)).toEqual(["one", "goal-card"]);
  expect(roomProviderSystem("Room identity\n" + goal.instructions, goalPlan.goal)).toBe(
    "Room identity\nCoordinate the goal.\nGoal: See the current room request.\nReport the outcome.",
  );
  expect(() => roomProviderSystem("Room identity", goalPlan.goal)).toThrow(/no longer match/);
  expect(() => roomProviderSystem(goal.instructions.repeat(2), goalPlan.goal)).toThrow(
    /no longer match/,
  );
  expect(roomProviderSystem("Regular room instructions", plan.goal)).toBe(
    "Regular room instructions",
  );
  const followup = {
    ...goal,
    turnCount: 2,
    instructions: "Worker.\nGoal: Own request\nYour assignment: Check result\nFinish.",
    continuation: {
      previousTurnId: "previous-turn",
      reply: "<openmaus-goal>decision</openmaus-goal>",
      assignment: "Check result",
      coordinator: true,
      itemIds: ["control-item"],
    },
  } as const;
  const secondOp = { ...goalOperation, id: "operation-step-2", goal: followup, sourceRowIds: [] };
  const second = validateColdNativeRoomTurn(read({ ...goalRoom, operation: secondOp })!, input);
  expect(second.currentRows).toEqual([]);
  expect(second.historicalRows.map((row) => row.id)).toEqual(["one", "two", "goal-card"]);
  expect(roomProviderSystem(followup.instructions, second.goal)).toBe(
    "Worker.\nGoal: Continue the saved room goal.\nYour assignment: See the current coordinator assignment.\nFinish.",
  );
  expect(() =>
    validateColdNativeRoomTurn(
      read({ ...goalRoom, operation: { ...secondOp, sourceRowIds: ["two"] } })!,
      input,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      read({
        ...goalRoom,
        operation: {
          ...secondOp,
          goal: {
            ...followup,
            continuation: { ...followup.continuation, previousTurnId: "turn" },
          },
        },
      })!,
      input,
    ),
  ).toThrow();
  const transferredGoal = {
    ...followup,
    continuation: {
      ...followup.continuation,
      fromMemberId: "native-bot",
      targetMemberId: "peer",
    },
  };
  const peerRoom = {
    ...goalRoom,
    botId: "peer",
    operation: { ...secondOp, goal: transferredGoal },
  };
  const peerInput = { ...input, botId: "peer" };
  expect(validateColdNativeRoomTurn(read(peerRoom, "peer")!, peerInput).currentRows).toEqual([]);
  const senderProject = ProjectId.make("project-a");
  const recipientProject = ProjectId.make("project-b");
  const recipient = {
    memberId: "peer",
    projectId: recipientProject,
    workspace: input.cwd,
    selection: {
      ...saved.threadSelection,
      instanceId: ProviderInstanceId.make(saved.threadSelection.instanceId),
    },
    approvalMode: "ask",
    restrictedTools: true,
  } as const;
  const boundPeer = read({ ...peerRoom, memberBindings: [recipient] }, "peer")!;
  expect(
    ownedNativeRoomProject(recipientProject, boundPeer.memberBindings?.[0], recipientProject),
  ).toBe(recipientProject);
  expect(ownedNativeRoomProject(senderProject, boundPeer.memberBindings?.[0])).toBeUndefined();
  expect(
    ownedNativeRoomProject(recipientProject, boundPeer.memberBindings?.[0], senderProject),
  ).toBeUndefined();
  expect(ownedNativeRoomProject(recipientProject, undefined, recipientProject)).toBeUndefined();
  expect(validateColdNativeRoomTurn(boundPeer, peerInput).currentRows).toEqual([]);
  expect(() =>
    validateColdNativeRoomTurn(
      {
        ...boundPeer,
        memberBindings: [{ ...recipient, workspace: NodePath.resolve("different-workspace") }],
      },
      peerInput,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      { ...boundPeer, memberBindings: [{ ...recipient, effort: "high" }] },
      peerInput,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      read(
        {
          ...peerRoom,
          operation: {
            ...secondOp,
            goal: {
              ...transferredGoal,
              continuation: { ...transferredGoal.continuation, fromMemberId: "removed" },
            },
          },
        },
        "peer",
      )!,
      peerInput,
    ),
  ).toThrow();
  for (const changed of [
    { ...goal, coordinatorBotId: "peer" },
    { ...goal, cardMessageId: "one" },
    { ...goal, requestId: "one" },
    { ...goal, goal: "Changed text" },
    { ...goal, startedAt: 4 },
    { ...goal, status: "stopped" },
    { ...goal, turnCount: 2 },
  ]) {
    expect(() =>
      validateColdNativeRoomTurn(
        read({ ...goalRoom, operation: { ...goalOperation, goal: changed } })!,
        input,
      ),
    ).toThrow();
  }
  expect(() =>
    validateColdNativeRoomTurn(
      read({ ...goalRoom, operation: { ...goalOperation, handedFor: {} } })!,
      input,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      read({
        ...goalRoom,
        rows: [
          goalRoom.rows[0],
          { ...goalRoom.rows[1], provenance: { authority: "information", channelMode: "goal" } },
          goalRoom.rows[2],
        ],
      })!,
      input,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn({ ...cold, operation: { ...cold.operation, kind: "card" } }, input),
  ).toThrow(/cold person chat/);
  const parked = {
    cardId: "card",
    requestId: "provider:question",
    nodeId: "prior-node",
    priorTurnId: "prior-turn",
    sourceMessageId: "two",
    person: "paired-person",
    answer: "Use the second option.",
  };
  const parkedRoom = {
    ...cold,
    operation: {
      ...cold.operation,
      id: "prior-node-answered",
      kind: "card" as const,
      sourceRowIds: [],
      parked,
    },
    rows: [
      ...cold.rows,
      {
        id: "card",
        at: 3,
        role: "bot" as const,
        kind: "options",
        provenance: { authority: "information" as const, from: { botId: "native-bot" } },
      },
    ],
  };
  const parkedPlan = validateColdNativeRoomTurn(read(parkedRoom)!, input);
  expect(parkedPlan.parked?.answer).toBe(parked.answer);
  expect(parkedPlan.currentRows).toEqual([]);
  expect(() =>
    validateColdNativeRoomTurn(
      { ...parkedRoom, operation: { ...parkedRoom.operation, parked: { ...parked, person: "" } } },
      input,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      {
        ...parkedRoom,
        operation: { ...parkedRoom.operation, parked: { ...parked, priorTurnId: "turn" } },
      },
      input,
    ),
  ).toThrow();
  const chainedProof = {
    ...parked,
    priorGeneration: "first-answer-generation",
    priorExecution: 2,
    requestId: "provider:second-question",
    answer: "Use the third option.",
  };
  const chainedRoom = {
    ...parkedRoom,
    operation: { ...parkedRoom.operation, id: "prior-node-answered-3", parked: chainedProof },
    rows: parkedRoom.rows.map((row) =>
      row.id === parked.cardId ? { ...row, parkedAnswer: chainedProof } : row,
    ),
  };
  expect(validateColdNativeRoomTurn(read(chainedRoom)!, input).parked?.answer).toBe(
    chainedProof.answer,
  );
  expect(() =>
    validateColdNativeRoomTurn(
      read({
        ...chainedRoom,
        operation: { ...chainedRoom.operation, generation: chainedProof.priorGeneration },
      })!,
      input,
    ),
  ).toThrow(/cold person chat/);
  expect(() =>
    validateColdNativeRoomTurn(
      read({ ...parkedRoom, operation: { ...parkedRoom.operation, generation: parked.nodeId } })!,
      input,
    ),
  ).toThrow(/cold person chat/);
  expect(() =>
    validateColdNativeRoomTurn({ ...chainedRoom, rows: parkedRoom.rows }, input),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      {
        ...chainedRoom,
        operation: {
          ...chainedRoom.operation,
          parked: { ...chainedProof, answer: "Changed after saving" },
        },
      },
      input,
    ),
  ).toThrow();
  expect(() =>
    validateColdNativeRoomTurn(
      { ...cold, operation: { ...cold.operation, sourceRowIds: ["one", "two"] } },
      input,
    ),
  ).toThrow(/cold person chat/);
  expect(() => validateColdNativeRoomTurn(cold, { ...input, approvalMode: "full" })).toThrow(
    /current policy/,
  );
  expect(read(null)).toBeNull();
  expect(() => read(snapshot, "peer")).toThrow(/member turn/);
  expect(() => read(snapshot, "native-bot", "private-task")).toThrow(/member turn/);
  expect(() => read(snapshot, "native-bot", "room-task", "foreign-turn")).toThrow(/member turn/);
  expect(() => read({ ...snapshot, roster: ["peer"] })).toThrow(/member turn/);
  expect(() => read({ ...snapshot, rows: [...snapshot.rows].reverse() })).toThrow(
    /saved row order/,
  );
  expect(() =>
    read({ ...snapshot, operation: { ...snapshot.operation, queuedIds: ["q1", "foreign"] } }),
  ).toThrow(/saved row order/);
  expect(readNativeBotEnrollmentSnapshot(saved, "native-bot", "native-thread")?.threadId).toBe(
    "native-thread",
  );

  const sandbox = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-cold-room-files-"));
  const source = NodePath.join(sandbox, "native");
  const destination = NodePath.join(sandbox, "j1");
  try {
    await NodeFSP.mkdir(source);
    await NodeFSP.writeFile(NodePath.join(source, "room-file.txt"), "room file");
    const room = {
      ...cold,
      rows: cold.rows.map((row) => ({
        ...row,
        attachments:
          row.id === "two"
            ? [
                {
                  kind: "file" as const,
                  path: "/api/attachments/room-file.txt",
                  mime: "text/plain",
                },
              ]
            : [],
      })),
    };
    const staged = await stageColdNativeRoomAttachments(
      room,
      source,
      destination,
      plan.threadId,
      () => true,
    );
    expect(staged.rows[1]?.stagedAttachments[0]).toMatchObject({
      name: "room-file.txt",
      sizeBytes: 9,
    });
    await expect(
      stageColdNativeRoomAttachments(room, source, destination, plan.threadId, () => false),
    ).rejects.toThrow(/no longer owns/);
    const escaped = {
      ...room,
      rows: room.rows.map((row) => ({
        ...row,
        attachments: [
          { kind: "file" as const, path: "/api/attachments/../foreign.txt", mime: "text/plain" },
        ],
      })),
    };
    await expect(
      stageColdNativeRoomAttachments(escaped, source, destination, plan.threadId, () => true),
    ).rejects.toThrow(/attachment name/);
  } finally {
    await NodeFSP.rm(sandbox, { recursive: true, force: true });
  }
});
