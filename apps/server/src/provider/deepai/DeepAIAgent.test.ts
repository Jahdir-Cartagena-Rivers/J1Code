import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createDeepAIAgent } from "./DeepAIAgent.ts";
import type { CommandJobResult } from "./CommandJobs.ts";

// Exercise the bundled SDK and its real owned Windows shell without any model requests.
it.skipIf(HostProcessPlatform.defaultValue() !== "win32")(
  "runs, rejects, supervises and stops real SDK shell jobs",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "j1-command-jobs-"));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No network in fixture"));
    const output = Promise.withResolvers<void>();
    let allowActions = true;
    const agent = await createDeepAIAgent({
      cwd: directory,
      agentDir: NodePath.join(directory, "config"),
      sessionDir: NodePath.join(directory, "sessions"),
      apiKey: "synthetic-no-network",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 4096,
          maxTokens: 512,
        },
      ],
      modelId: "fixture",
      systemPrompt: "Isolated shell fixture.",
      authorize: async () => allowActions,
      onEvent: () => {},
      onCommandJob: (job) => {
        if (job.output.includes("dispose-ready")) output.resolve();
      },
    });
    let callId = 0;
    const execute = (name: string, params: Record<string, unknown>) => {
      const tool = agent.session.agent.state.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Missing registered tool: ${name}`);
      return tool.execute(`fixture-${++callId}`, params, new AbortController().signal);
    };
    const parse = (
      value: Awaited<ReturnType<typeof execute>>,
    ): CommandJobResult & { backgrounded?: boolean } =>
      JSON.parse(
        value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      );
    try {
      const toolCall = {
        type: "toolCall",
        id: "denied",
        name: "powershell",
        arguments: { command: "Write-Output 'denied'" },
      } as const;
      allowActions = false;
      expect(
        await agent.session.agent.beforeToolCall!({
          toolCall,
          args: toolCall.arguments,
          context: {
            messages: [],
            tools: agent.session.agent.state.tools,
          },
          assistantMessage: {
            role: "assistant",
            content: [toolCall],
            api: "openai-completions",
            provider: "deepai",
            model: "fixture",
            stopReason: "toolUse",
            timestamp: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        }),
      ).toMatchObject({ block: true, reason: "J1 denied this action." });
      allowActions = true;
      expect(parse(await execute("bash", { command: "printf bash-neighbor" }))).toMatchObject({
        state: "completed",
        output: "bash-neighbor",
        exitCode: 0,
      });
      expect(
        parse(await execute("powershell", { command: "Write-Output 'native-世界'" })),
      ).toMatchObject({
        state: "completed",
        exitCode: 0,
        output: expect.stringContaining("native-\u4e16\u754c"),
      });
      await expect(
        execute("powershell", { command: "Write-Output 'failure'; exit 7" }),
      ).rejects.toThrow('"exitCode":7');
      await expect(execute("command_status", { jobId: "another-session" })).rejects.toThrow(
        "Unknown command job",
      );
      const command = "Write-Output 'background-ready'; Start-Sleep -Seconds 60";
      const running = parse(await execute("powershell", { command }));
      expect(running).toMatchObject({ state: "running", backgrounded: true });
      expect(parse(await execute("powershell", { command })).id).toBe(running.id);
      expect(parse(await execute("command_cancel", { jobId: running.id })).cancelRequested).toBe(
        true,
      );
      expect(
        parse(await execute("command_status", { jobId: running.id, waitSeconds: 20 })).state,
      ).toBe("cancelled");
      const ending = execute("powershell", {
        command: "Write-Output 'dispose-ready'; Start-Sleep -Seconds 60",
      });
      const rejected = expect(ending).rejects.toThrow('"state":"cancelled"');
      await output.promise;
      await agent.stop();
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await agent.stop();
      fetch.mockRestore();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
  40000,
);
