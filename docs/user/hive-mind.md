# Hive Mind

J1 uses its own built-in memory by default, managed by the selected J1 server.
You can optionally use the separate
[standalone Hive Mind service](https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind)
as its primary brain. It is not started or connected automatically. See
[the licensing boundary](../../HIVE-MIND-LICENSING.md) before reusing code from
the standalone repository.

## Choose the primary brain

Open **Settings → Hive Mind** for the environment and select built-in memory or
standalone Hive Mind, then save setup. On mobile, use **Use standalone Hive Mind**.
Built-in mode works without the standalone app. Switching preserves both stores
and the connection settings; it does not copy, merge or delete their contents.

External mode reads the connection file on the J1 server, normally
`~/.hive-mind/connection.json`. For remote clients, this is a file on the server
host, not on your phone or browser device. A custom connection file can point to
an authenticated HTTPS service. Credentials stay on the server. If the external
service is unavailable, J1 reports the problem and does not write into another
store as a fallback. Switch back to built-in to use the existing local memories.

In standalone mode, memory tools and automatic turn context use the selected
service. Ask your agent to create or update a task, retain a reference image or
file, or continue an existing task in another chat. Explicit task binding carries
that task's context across project surfaces; unrelated project instructions stay
scoped. The source chat remains in J1. Compact request excerpts, turn outcomes
and context delivery receipts are retained for continuity. They are evidence,
not automatically confirmed preferences or proof that a task is complete.

Use the standalone app for visual reference collections, annotations, preferences,
artifact history and backups. Relevant retained images and files are retrieved
into J1's attachment storage for provider adapters; actual image understanding
depends on the chosen provider's capabilities. Manage the standalone vault,
skills and indexing in Hive Mind; J1's built-in setup remains separate.

## Built-in memory

Hive Mind keeps facts that Claude and Codex can use across J1 Code chats and projects on the same server. When you explain a lasting preference, project decision, or named concept, the agent can save it. You can also say “remember this in Hive Mind” and describe the fact directly.

Ask “what does Hive Mind know about Nebula?” to inspect matching facts. To correct a fact, give the new version and ask the agent to remember it under the same subject. To remove one, ask the agent to forget it. Each entry records the chat that supplied it.

J1 Code adds a small selection of matching general facts and current-project facts to each turn. Facts from another project and imported Codex preferences with ambiguous project scope are available through an explicit Hive Mind search rather than being added automatically. Treat remembered facts as context: the agent should check current files and runtime state before making claims about either.

Hive Mind is stored with the server's local data. You can import Codex's local summaries, detailed memory records, rollout summaries, and memory skills, along with Claude Code's local project memory notes. Claude.ai account memory can be added from an explicit memory export. The import leaves the originals in place and labels every note with its source. Repeating it updates source-owned notes while preserving corrections you made in J1 Code. Imported notes may be old, so ask the agent to verify them against current project files before acting.

Open **Settings → Hive Mind** for the selected environment to set up the vault, semantic retrieval, and skills folders. Search, add, edit, and forget memories there, or use the same operations through your agent. On mobile, open an environment in Settings and select Hive Mind. Remote clients manage the selected server's memory and folders.

Automatic synchronization exports saved memories, checks vault and skill edits every 30 seconds, and refreshes semantic retrieval in the background. The page shows pending work, conflicts, and failures. You can pause automatic synchronization or request a synchronization yourself. Your existing facts remain usable if semantic retrieval is offline; search reports that degraded state.

Open the configured vault in Obsidian or another Markdown editor. Edit the body of a note in its `Hive Mind` folder and keep its frontmatter unchanged. If another chat corrected that fact while you were editing, synchronization preserves both versions and reports a conflict. Forgotten notes move to the vault's `Forgotten` folder and cannot recreate a memory through synchronization. Add new memories through Hive Mind; unrelated vault notes are left alone. Each memory supports up to 2,000 characters.

Ask Hive Mind to find a skill for a task. Catalog results describe the skill and point to its original `SKILL.md`; finding a skill does not run it. Skills are included in explicit searches, rather than automatically added to every conversation.

To bring existing Hindsight knowledge into Hive Mind, use **Existing knowledge** on the same settings page and enter its source bank. Import reads the original documents without changing the source bank. Long documents become separately searchable excerpts. These imports stay in their own source scope and appear in explicit searches; they are not automatically added to unrelated project conversations. Repeating an import preserves your corrections and forgotten entries.
