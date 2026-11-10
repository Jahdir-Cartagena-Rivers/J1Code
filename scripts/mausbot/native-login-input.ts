type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/** Private browser input: never return native input responses, which may contain values. */
export function nativeLoginInput(call: Call) {
  async function run(name: string, args: Record<string, unknown>) {
    let result: unknown;
    try {
      result = await call(name, args);
    } catch {
      throw new Error("The login page is unavailable. Reopen it and try again.");
    }
    const answer = result as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
    };
    if (!answer || answer.isError) throw new Error("The login page changed or refused this input.");
    return answer;
  }
  return {
    engine: async (args: string[]): Promise<Record<string, unknown> | null> => {
      const url = args.length === 2 && args[0] === "get" && args[1] === "url";
      if (!url && !(args.length === 2 && args[0] === "eval")) return null;
      const answer = await run("evaluate", {
        script: url ? "JSON.stringify({url:location.href})" : args[1],
      });
      const value = answer.content?.find((entry) => entry.type === "text")?.text;
      if (typeof value !== "string") throw new Error("The browser returned an invalid login page.");
      if (!url) return { result: value };
      try {
        const page = JSON.parse(value);
        return typeof page?.url === "string" ? { url: page.url } : null;
      } catch {
        return null;
      }
    },
    insertText: async (text: string) => {
      await run("fill", { selector: ":focus", value: text });
    },
    press: async (key: string) => {
      await run("press", { selector: ":focus", key });
    },
    click: async (selector: string) => {
      await run("click", { selector });
    },
  };
}
