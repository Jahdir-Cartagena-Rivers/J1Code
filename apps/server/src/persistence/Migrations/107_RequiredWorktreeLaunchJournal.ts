import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE orchestration_v2_thread_launch_workflows
    ADD COLUMN required_worktree_request TEXT
  `;
  yield* sql`ALTER TABLE orchestration_v2_thread_launch_workflows ADD COLUMN required_worktree_marker TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_thread_launch_workflows ADD COLUMN required_worktree_head TEXT`;
  yield* sql`ALTER TABLE orchestration_v2_thread_launch_workflows ADD COLUMN required_worktree_base TEXT`;
});
