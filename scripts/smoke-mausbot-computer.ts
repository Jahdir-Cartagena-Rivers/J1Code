import * as NodePath from "node:path";
import { startMausbotComputer } from "../apps/server/src/mausbot/NativeComputer.ts";
import { LightpandaProcess } from "../apps/server/src/mcp/LightpandaProcess.ts";

if (process.platform !== "win32" || !process.argv[2])
  throw new Error("Supply a Windows runtime resources directory.");
const computer = await startMausbotComputer(NodePath.resolve(process.argv[2]));
let proxy: LightpandaProcess | undefined;
try {
  const saved = Object.fromEntries(
    Object.keys(computer.descriptor.mcpEnv).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, computer.descriptor.mcpEnv);
    proxy = new LightpandaProcess(computer.descriptor.mcpCommand, computer.descriptor.mcpArgs);
  } finally {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
  await proxy.initialize();
  const result = (await proxy.request("tools/list", {})) as { tools?: Array<{ name: string }> };
  if (
    !result.tools?.some((tool) => tool.name === "click") ||
    !result.tools.some((tool) => tool.name === "list_apps")
  )
    throw new Error("The native helper did not advertise the required tools.");
  console.log(
    `J1_MAUSBOT_COMPUTER_METADATA_OK: ${result.tools.length} tool definitions, no screen capture or input.`,
  );
} finally {
  proxy?.close();
  await computer.stop();
}
