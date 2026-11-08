import type { ConversationCall, ConversationPrincipal } from "@t3tools/contracts";
import type { ExternalConversations } from "./ExternalConversations.ts";

export const conversationCall = (
  directory: ExternalConversations["Service"],
  principal: ConversationPrincipal,
  input: ConversationCall,
) => {
  switch (input.action) {
    case "search":
      return directory.search(principal, input.query);
    case "read":
      return directory.read(principal, input.endpoint, input.cursor);
    case "readMessage":
      return directory.readMessage(principal, input.endpoint, input.messageId, input.offset ?? 0);
  }
};
