# Hive Mind

Hive Mind keeps facts that Claude and Codex can use across J1 Code chats and projects on the same server. When you explain a lasting preference, project decision, or named concept, the agent can save it. You can also say “remember this in Hive Mind” and describe the fact directly.

Ask “what does Hive Mind know about Nebula?” to inspect matching facts. To correct a fact, give the new version and ask the agent to remember it under the same subject. To remove one, ask the agent to forget it. Each entry records the chat that supplied it.

General facts can appear in any project. Project facts are labeled with a project name, but searches can still find them from other projects. J1 Code adds a small selection of matching facts to each turn. Treat remembered facts as context: the agent should check current files and runtime state before making claims about either.

Hive Mind is stored with the server's local data. You can import Codex's local summaries, detailed memory records, rollout summaries, and memory skills, along with Claude Code's local project memory notes. Claude.ai account memory can be added from an explicit memory export. The import leaves the originals in place and labels every note with its source. Repeating it updates source-owned notes while preserving corrections you made in J1 Code. Imported notes may be old, so ask the agent to verify them against current project files before acting.
