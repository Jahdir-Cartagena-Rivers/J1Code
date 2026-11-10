/** Runtime-only capability values: never persist the bridge bearer in bot settings. */
export function deepAIBridgeConfig(environment: NodeJS.ProcessEnv = process.env) {
  const url = environment.OMB_J1_DEEPAI_URL;
  const token = environment.OMB_J1_DEEPAI_TOKEN;
  if (
    !url ||
    !/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1$/.test(url) ||
    !token ||
    !/^[A-Za-z0-9_-]{40,}$/.test(token)
  )
    throw new Error("J1 DeepAI is unavailable. Connect the parent server, then refresh providers.");
  return { url, token };
}
