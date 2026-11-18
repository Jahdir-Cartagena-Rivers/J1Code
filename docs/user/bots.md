# Bots

Bots appear above Chats in the shared sidebar. Use the crowned bot for general requests. Use the add menu to create another bot, choose its model and instructions, then open its profile to manage memory, skills, access and routines. Existing J1 projects and chats remain available. Previous Home conversations remain saved.

J1 uses the OpenMausBot open-source assistant runtime. Its browser uses J1’s lightweight native browser and shares the same session between the bot and the browser panel. It needs no Docker installation. The panel shows a safe page view; it can look different from a full visual browser.

Local notes remain the default. In a bot’s Memory settings, **Hive Mind extended memory** can copy its notes to your configured Hive Mind and retrieve relevant passages beyond the always-loaded prefix. Use **Enable and copy notes** to authorize copying; existing notes stay editable. See [Hive Mind](hive-mind.md#assistant-notes).

Previous custom J1 bot profiles and their conversation history remain saved while that roster and its scheduled routines are retired from use.

Bots and project chats can search saved conversations, read matching messages and link to the original conversation. They can also [forward requests](composer.md#routing-requests-between-conversations) to an existing work owner. Cross-engine forwarding currently supports unrestricted Full access profiles; mappings for other permission profiles are not yet implemented, so those requests remain pending.

Choose **J1 shared providers** in a bot's model picker to use the same configured accounts and execution services as project chats. Compatible default accounts move automatically while keeping their models, instructions, conversations and permission modes. Custom accounts and native tool restrictions stay on their existing engine until a compatible shared configuration is selected.

In the bot's Identity settings, **J1 project for this thread** attaches a project’s folder, instructions, files and memory to that bot thread. Each thread keeps its own project. Start a new thread to work on another project after a session has begun.

To combine the J1 Project Builder with the engineering department, open its Identity settings and choose **Set up engineering team**. Its saved identity and conversations become Ada’s lead role. Lin, Pixel, Rigel and an Engineering Room are added once. Head Admin stays the general manager; you can give engineering work directly to the department.
