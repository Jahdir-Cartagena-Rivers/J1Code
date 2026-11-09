# Import your bots

The welcome popup offers **Import from OpenMaus** and **Import from Grok**. You can skip it and return to **Settings → Import** later.

For OpenMaus, export a workspace backup from **Settings → Backups** in OpenMaus. In J1 Code, choose **Import from OpenMaus**, select the `.ombbackup` file, and enter its backup password. Review the preview, warnings, and exclusions before confirming. Restart J1 Code to finish the restore.

The workspace backup carries bots, conversations, memories, routines, and files. Credentials, external sign-ins, and device connections follow the exclusions shown in the preview and may need reconnecting. Your original OpenMaus workspace is unchanged.

Restoring replaces the bot workspace on the connected J1 server; it does not merge it with existing bots. The restore keeps a safety copy of the previous bot workspace. J1 coding projects and coding conversations remain separate. When connected remotely, the restore applies to the server you are connected to.

For Grok, choose **Import from Grok** and follow the existing export instructions in the dialog.
