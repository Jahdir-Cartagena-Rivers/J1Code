# Hive Mind

Hive Mind keeps facts that Claude and Codex can use across J1 Code chats and projects on the same server. When you explain a lasting preference, project decision, or named concept, the agent can save it. You can also say “remember this in Hive Mind” and describe the fact directly.

Ask “what does Hive Mind know about Nebula?” to inspect matching facts. To correct a fact, give the new version and ask the agent to remember it under the same subject. To remove one, ask the agent to forget it. Each entry records the chat that supplied it.

J1 Code adds a small selection of matching general facts and current-project facts to each turn. Facts from another project and imported Codex preferences with ambiguous project scope are available through an explicit Hive Mind search rather than being added automatically. Treat remembered facts as context: the agent should check current files and runtime state before making claims about either.

Hive Mind is stored with the server's local data. You can import Codex's local summaries, detailed memory records, rollout summaries, and memory skills, along with Claude Code's local project memory notes. Claude.ai account memory can be added from an explicit memory export. The import leaves the originals in place and labels every note with its source. Repeating it updates source-owned notes while preserving corrections you made in J1 Code. Imported notes may be old, so ask the agent to verify them against current project files before acting.

Open **Settings → Hive Mind** for the selected environment to set up the vault, semantic retrieval, and skills folders. Search, add, edit, and forget memories there, or use the same operations through your agent. On mobile, open an environment in Settings and select Hive Mind. Remote clients manage the selected server's memory and folders.

Automatic synchronization exports saved memories, checks vault and skill edits every 30 seconds, and refreshes semantic retrieval in the background. The page shows pending work, conflicts, and failures. You can pause automatic synchronization or request a synchronization yourself. Your existing facts remain usable if semantic retrieval is offline; search reports that degraded state.

Open the configured vault in Obsidian or another Markdown editor. Edit the body of a note in its `Hive Mind` folder and keep its frontmatter unchanged. If another chat corrected that fact while you were editing, synchronization preserves both versions and reports a conflict. Forgotten notes move to the vault's `Forgotten` folder and cannot recreate a memory through synchronization. Add new memories through Hive Mind; unrelated vault notes are left alone. Each memory supports up to 2,000 characters.

Ask Hive Mind to find a skill for a task. Catalog results describe the skill and point to its original `SKILL.md`; finding a skill does not run it. Skills are included in explicit searches, rather than automatically added to every conversation.

To bring existing Hindsight knowledge into Hive Mind, use **Existing knowledge** on the same settings page and enter its source bank. Import reads the original documents without changing the source bank. Long documents become separately searchable excerpts. These imports stay in their own source scope and appear in explicit searches; they are not automatically added to unrelated project conversations. Repeating an import preserves your corrections and forgotten entries.
