# Operating Hive Mind

Hive Mind owns the authoritative records in the server's `userdata/hive-mind.json`. Its Markdown vault and semantic retrieval index are derived from those records. Configure them on the server machine; remote clients use the same Hive Mind tools and never need local access to these paths. Existing installations without configuration retain local fact search.

Use **Settings → Hive Mind** in a client connected to the intended environment. Configuration requires environment access-management permission; memory writes and manual synchronization require operate permission. You can also create a configuration file with absolute paths appropriate to that server:

```json
{
  "version": 1,
  "automatic": true,
  "vault": "C:\\Knowledge\\Hive Mind",
  "hindsight": {
    "url": "http://127.0.0.1:8888",
    "bank": "j1-hive-mind",
    "timeoutMs": 60000
  },
  "skills": [
    { "path": "C:\\Knowledge\\Skills" },
    { "path": "C:\\Projects\\J1_Code\\.agents\\skills", "project": "J1Code" }
  ]
}
```

Use a dedicated Hive Mind retrieval bank rather than an existing unrelated bank; the setup page supplies an environment-specific default. The vault and skills capabilities work without semantic retrieval. Omit a capability from the configuration to disable its synchronization.

For the existing local Windows Hindsight installation, the optional `localEngine.directory` points to the folder containing `run_api.py` and `.venv`. The background worker checks loopback service health before launching the existing virtual-environment Python script. It restores installed Ollama from its standard Windows location, or `localEngine.ollama` can supply an absolute executable path. It preserves the installation's settings and data. Spawned services run hidden and persist when J1 exits; captured PID receipts and output live in the environment's `logs/hive-mind` folder. Healthy shared services are reused and are never stopped. Remote retrieval endpoints are supported without local engine recovery.

Preview configuration, then apply it to the intended environment:

```powershell
node apps/server/src/hiveMind/manage.cli.ts configure --target C:\path\to\userdata\hive-mind.json --config C:\path\to\config.json
node apps/server/src/hiveMind/manage.cli.ts configure --target C:\path\to\userdata\hive-mind.json --config C:\path\to\config.json --apply
node apps/server/src/hiveMind/manage.cli.ts sync --target C:\path\to\userdata\hive-mind.json
node apps/server/src/hiveMind/manage.cli.ts status --target C:\path\to\userdata\hive-mind.json
```

Provider agents expose `hive_mind_status` and `hive_mind_sync` for the same operations. Dot's existing Hive Mind searches use the unified retrieval path and retain their separate OAuth read/write grants. Dot does not receive management tools in this initial implementation.

Remembering a fact persists it immediately and wakes the environment's background worker. Automatic scans check vault and skill edits every 30 seconds. Retrieval batches contain at most ten changed records; completed index receipts survive restarts, and failed work remains pending. Set `automatic` to false to pause the worker's automatic scans and wakeups. Manual synchronization remains available. The source CLI exits unsuccessfully when synchronization reports issues; inspect those issues before retrying. Search falls back to local facts if retrieval fails.

Only the body of generated vault notes is editable. A stale body edit cannot replace a newer canonical revision. To resolve a conflict, inspect the canonical fact through recall and your preserved Markdown edit, then make the intended correction through the agent. Move the conflicting note outside the vault's `Hive Mind` folder to preserve it for review, and synchronize again to export a fresh note with current frontmatter. Skill descriptions are discovered from allowlisted `SKILL.md` frontmatter; edit the original skill file to change them. Skill discovery never executes instructions, hooks, or code.

Validate new configurations against copied memory in an isolated directory before enabling them on an installed server. Do not point a test server or test synchronization at live userdata. Engine recovery uses the existing installation; it does not download models or install Python dependencies. Existing-knowledge import is explicit and read-only at the source bank. It imports original documents up to 128 KiB each, with limits of 1,000 documents and 4,096 excerpts per request, and skips Hive Mind's own generated retrieval documents.
