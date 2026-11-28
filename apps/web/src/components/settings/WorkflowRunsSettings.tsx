import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@j1code/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type WorkflowRunsAboutInput,
  type WorkflowQuestion,
  WS_METHODS,
} from "@j1code/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const runs = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "workflow-runs",
  tag: WS_METHODS.workflowsSubscribe,
});
const detail = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "workflow-run",
  tag: WS_METHODS.workflowsGet,
  staleTimeMs: 0,
});
const about = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "workflow-subject-runs",
  tag: WS_METHODS.workflowsAbout,
  staleTimeMs: 0,
});
const resume = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workflow-resume",
  tag: WS_METHODS.workflowsResume,
});
const cancel = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workflow-cancel",
  tag: WS_METHODS.workflowsCancel,
});
const answer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "workflow-answer",
  tag: WS_METHODS.workflowsAnswer,
});

function resultError(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Workflow request failed.";
}

function Question({
  environmentId,
  question,
  canOperate,
}: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  readonly canOperate: boolean;
}) {
  const sendAnswer = useAtomCommand(answer, { reportFailure: false });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const request = question.request;
  const fields =
    request !== null && typeof request === "object" && !Array.isArray(request) ? request : null;
  const choices =
    fields !== null && "choices" in fields && Array.isArray(fields.choices)
      ? fields.choices.filter((value): value is string => typeof value === "string")
      : [];
  const title =
    fields !== null && "title" in fields && typeof fields.title === "string"
      ? fields.title
      : question.name;
  return (
    <SettingsRow
      title={title}
      description={error ?? undefined}
      control={
        canOperate && choices.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Reason for answer"
              placeholder="Reason"
              size="sm"
              value={reason}
              onChange={(event) => setReason(event.currentTarget.value)}
            />
            {choices.map((choice) => (
              <Button
                key={choice}
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  void sendAnswer({
                    environmentId,
                    input: {
                      runId: question.runId,
                      name: question.name,
                      choice,
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    },
                  })
                    .then((result) => setError(resultError(result)))
                    .finally(() => setPending(false));
                }}
              >
                {choice}
              </Button>
            ))}
          </div>
        ) : undefined
      }
    />
  );
}

function RunDetails({
  environmentId,
  runId,
}: {
  readonly environmentId: EnvironmentId;
  readonly runId: string;
}) {
  const result = useAtomValue(detail({ environmentId, input: { runId } }));
  const data = AsyncResult.getOrElse(result, () => null);
  if (data === null) return <SettingsRow title={resultError(result) ?? "Loading run…"} />;
  return (
    <div>
      {data.steps.map((step) => (
        <SettingsRow
          key={step.name}
          title={step.name}
          description={step.detail ?? undefined}
          control={step.status}
        />
      ))}
    </div>
  );
}

function WorkflowSubjectRunsList({
  environmentId,
  subject,
}: {
  readonly environmentId: EnvironmentId;
  readonly subject: WorkflowRunsAboutInput;
}) {
  const result = useAtomValue(about({ environmentId, input: subject }));
  const data = AsyncResult.getOrElse(result, () => null);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [selected, select] = useState<string | null>(null);
  const error = resultError(result);
  if (error || !data || (data.runs.length === 0 && data.questions.length === 0)) return null;
  return (
    <SettingsSection title="Workflow runs">
      {data.questions.map((question) => (
        <Question
          key={`${question.runId}:${question.name}`}
          environmentId={environmentId}
          question={question}
          canOperate={canOperate}
        />
      ))}
      {data.runs.map((run) => (
        <div key={run.runId}>
          <SettingsRow
            title={run.title}
            description={run.status}
            control={
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => select(selected === run.runId ? null : run.runId)}
              >
                {selected === run.runId ? "Hide steps" : "Show steps"}
              </Button>
            }
          />
          {selected === run.runId && <RunDetails environmentId={environmentId} runId={run.runId} />}
        </div>
      ))}
    </SettingsSection>
  );
}

export function WorkflowSubjectRuns({
  environmentId,
  subject,
}: {
  readonly environmentId: EnvironmentId;
  readonly subject: WorkflowRunsAboutInput;
}) {
  const environment = useEnvironment(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  return canRead && environment?.serverConfig?.settings.workflowsEnabled ? (
    <WorkflowSubjectRunsList environmentId={environmentId} subject={subject} />
  ) : null;
}

function WorkflowRuns({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(runs({ environmentId, input: {} }));
  const snapshot = AsyncResult.getOrElse(result, () => null);
  const data = snapshot !== null && "workflows" in snapshot ? snapshot : null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const resumeRun = useAtomCommand(resume, { reportFailure: false });
  const cancelRun = useAtomCommand(cancel, { reportFailure: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (data === null) return <SettingsRow title={resultError(result) ?? "Loading workflows…"} />;
  return (
    <>
      {data.questions.map((question) => (
        <Question
          key={`${question.runId}:${question.name}`}
          environmentId={environmentId}
          question={question}
          canOperate={canOperate}
        />
      ))}
      {data.workflows.map((workflow) => (
        <SettingsRow
          key={workflow.name}
          title={workflow.name}
          description={workflow.triggers.join(", ")}
        />
      ))}
      {data.runs.map((run) => (
        <div key={run.runId}>
          <SettingsRow
            title={run.title}
            description={run.status}
            control={
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setSelected(selected === run.runId ? null : run.runId)}
                >
                  {selected === run.runId ? "Hide steps" : "Show steps"}
                </Button>
                {canOperate && run.status === "paused" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void resumeRun({ environmentId, input: { runId: run.runId } })
                        .then((value) => setError(resultError(value)))
                        .finally(() => setPending(false));
                    }}
                  >
                    Resume
                  </Button>
                )}
                {canOperate && run.endedAt === null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      void cancelRun({ environmentId, input: { runId: run.runId } })
                        .then((value) => setError(resultError(value)))
                        .finally(() => setPending(false));
                    }}
                  >
                    Cancel run
                  </Button>
                )}
              </div>
            }
          />
          {selected === run.runId && <RunDetails environmentId={environmentId} runId={run.runId} />}
        </div>
      ))}
      {error && <SettingsRow title={error} />}
      {data.workflows.length === 0 && data.runs.length === 0 && (
        <SettingsRow title="No workflows registered" />
      )}
    </>
  );
}

function ReadableWorkflows({
  environmentId,
  title,
}: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return (
    <SettingsSection title={title}>
      <WorkflowRuns environmentId={environmentId} />
    </SettingsSection>
  );
}

export function WorkflowRunsSettings() {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  return scope.environmentIds.map((environmentId) => (
    <ReadableWorkflows
      key={environmentId}
      environmentId={environmentId}
      title={
        scope.environmentIds.length === 1
          ? "Workflow runs"
          : `Workflow runs · ${environments.find((entry) => entry.environmentId === environmentId)?.label ?? environmentId}`
      }
    />
  ));
}
