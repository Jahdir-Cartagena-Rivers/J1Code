# Hive Mind

Hive Mind is a separate application that keeps durable memory for your AI agents: a
searchable store, a built-in semantic index, a Markdown vault, a skills catalog, and a
graph you explore in its own window. J1 Code connects to it as a plugin and does not
contain it. Get it from the [Hive Mind repository](https://github.com/Jahdir-Cartagena-Rivers/Hive-Mind),
which is separately licensed (see [the licensing boundary](../../HIVE-MIND-LICENSING.md)).

## Connect J1 Code

Install and start the Hive Mind app on the same machine as your J1 Code server. It
writes `~/.hive-mind/connection.json`, which J1 Code reads automatically. There is
nothing to configure in J1 Code. If Hive Mind is not running, J1 Code works normally
and the memory tools report that Hive Mind is not available.

Once connected, agents can use `hive_mind_recall`, `hive_mind_remember`,
`hive_mind_forget`, `hive_mind_status` and `hive_mind_sync`, and J1 Code adds a small
selection of relevant general and current-project facts to each turn. Facts from
other projects and imported preferences with ambiguous scope remain available to
explicit searches.

Ask “what does Hive Mind know about Nebula?” to inspect facts. To correct one, give the
new version and ask the agent to remember it under the same subject. To remove one,
ask the agent to forget it.

Use the Hive Mind app for the graph, editing, vault, skills folders and importing
existing knowledge. If your J1 Code server runs on another machine, run Hive Mind on
that machine; remote clients use the same connection.

## Moving existing memories

Earlier J1 Code versions stored memories in `~/.j1/userdata/hive-mind.json`. Copy that
file into the Hive Mind app's data folder while neither app is running; see the Hive
Mind documentation. J1 Code no longer reads or writes it.
