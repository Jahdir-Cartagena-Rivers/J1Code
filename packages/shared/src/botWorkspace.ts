import { sha256 } from "@noble/hashes/sha2";
import { ProjectId, type BotId } from "@t3tools/contracts";

const PREFIX = "j1-bot:";

/** Stable internal project identity and workspace for a standalone bot. */
export function standaloneBotWorkspace(root: string, botId: BotId) {
  // Hash unusually long or malformed UTF-16 identifiers so every valid saved bot
  // has a portable single-component workspace without changing existing short IDs.
  const hashedIdentity = () => {
    const bytes = new Uint8Array(botId.length * 2);
    for (let i = 0; i < botId.length; i++) {
      const unit = botId.charCodeAt(i);
      bytes[i * 2] = unit >>> 8;
      bytes[i * 2 + 1] = unit & 0xff;
    }
    return `$${Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  let encoded: string;
  try {
    encoded = encodeURIComponent(botId).replace(/[A-Z.]/g, (character, offset, value: string) => {
      if (offset > 0 && value[offset - 1] === "%") return character;
      if (offset > 1 && value[offset - 2] === "%") return character;
      return `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
    });
    if (encoded.length > 180) encoded = hashedIdentity();
  } catch {
    encoded = hashedIdentity();
  }
  const separator = root.includes("\\") ? "\\" : "/";
  return {
    projectId: ProjectId.make(`${PREFIX}${encoded}`),
    workspaceRoot: `${root.replace(/[\\/]+$/, "")}${separator}bot-${encoded}`,
  };
}

export function isStandaloneBotProject(projectId: string): boolean {
  return projectId.startsWith(PREFIX);
}
