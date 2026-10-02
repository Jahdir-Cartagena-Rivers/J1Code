# Import native memories into Hive Mind

Run from the J1 Code source checkout. The target is the server's data directory, not the source checkout. Preview first:

```powershell
node apps/server/src/hiveMind/importNative.cli.ts --target "$env:USERPROFILE\.j1\userdata\hive-mind.json"
```

Apply the same previewed import:

```powershell
node apps/server/src/hiveMind/importNative.cli.ts --target "$env:USERPROFILE\.j1\userdata\hive-mind.json" --apply
```

Claude.ai account memory is separate from Claude Code's local notes. Anthropic's [memory export instructions](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude) say to open Claude's memory settings and copy the memory shown there, or ask Claude to write out its memories verbatim. Save that text as a local UTF-8 file, then add it to the same import:

```powershell
node apps/server/src/hiveMind/importNative.cli.ts --target "$env:USERPROFILE\.j1\userdata\hive-mind.json" --claude-account-memory "C:\path\to\claude-memory.md"
node apps/server/src/hiveMind/importNative.cli.ts --target "$env:USERPROFILE\.j1\userdata\hive-mind.json" --claude-account-memory "C:\path\to\claude-memory.md" --apply
```

The preview reports `claudeAccountEntries`. The CLI reads the export only when its path is provided, and does not send it to either provider.

The command reads Codex's `.codex/memories/MEMORY.md`, `memory_summary.md`, `raw_memories.md`, rollout summaries, and memory skills, plus Claude Code's `.claude/projects/*/memory/*.md` files. It does not read full chat transcripts, plugins, or account credentials, and it never changes source files. Credential-shaped values in memory text are redacted. The preview prints counts without printing memory contents. When a Hive Mind target already exists, `--apply` copies it to a sibling backup before writing. Repeating the command is safe: imported entries update from their own source, while entries corrected in J1 Code remain protected.

The installed J1 Code server must include the Hive Mind feature before agents can read the imported file. Until then, the import is staged data only.
