// Issues and pull requests for workflows: the same trackers and hosts the app's own Issues and
// Pull requests pages read, through the project's credentials. A step names a project the way
// an agent step does, by id or by folder.
import {
  IssueDetail,
  IssueListEntry,
  type IssueCreateResult,
  type IssueListState,
  IssueRef,
  type PullRequestAction,
  type PullRequestDetail,
  PullRequestListEntry,
  type PullRequestListState,
  type PullRequestMergeMethod,
  type PullRequestRef,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkflowReferenceKind,
} from "@j1code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";
import { issueReference, noteReference, pullRequestReference } from "./runReferences.ts";
import { isProjectPath } from "./WorkflowAgents.ts";
import type { ReferenceInput } from "./WorkflowStore.ts";

export class WorkflowForgeError extends Schema.TaggedError<WorkflowForgeError>()(
  "WorkflowForgeError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** What an issue trigger gives its run, and what `issues.list` returns rows of. */
export const Issue = IssueListEntry;
export type Issue = typeof Issue.Type;
/** What a pull request trigger gives its run, and what `pullRequests.list` returns rows of. */
export const PullRequest = PullRequestListEntry;
export type PullRequest = typeof PullRequest.Type;
export { IssueDetail };

/** An issue by its web address, or as a trigger or a listing gave it. */
export type IssueAddress =
  | { readonly project: string; readonly url: string }
  | Pick<Issue, "projectId" | "tracker" | "host" | "scope" | "key">;
/** A pull request by its web address, or as a trigger or a listing gave it. */
export type PullRequestAddress =
  | { readonly project: string; readonly url: string }
  | Pick<PullRequest, "projectId" | "host" | "repository" | "number">;

/** Where a pull request stands, as a wait on it gives it. */
export const PullRequestStanding = Schema.Struct({
  state: Schema.Literals(["open", "closed", "merged"]),
  /** `none` when the host lists no checks for it. */
  checks: Schema.Literals(["passing", "failing", "pending", "none"]),
  mergeability: Schema.Literals(["mergeable", "conflicting", "unknown"]),
  url: Schema.String,
});
export type PullRequestStanding = typeof PullRequestStanding.Type;
export type PullRequestUntil = "checks" | "merged" | "closed";
/** What a wait on a pull request keeps for the engine to look at. */
export interface PullRequestWatch {
  readonly kind: "pullRequest";
  readonly until: PullRequestUntil;
  readonly pullRequest:
    | { readonly project: string; readonly url: string }
    | {
        readonly projectId: string;
        readonly host: string;
        readonly repository: string;
        readonly number: number;
      };
}

// Checks take a moment to be listed after a push, so "none" only counts once it has stayed none.
const NO_CHECKS_AFTER_MS = 2 * 60_000;

/** Required checks decide when the host marks any as required; otherwise all of them do. */
export const standingOf = (
  detail: Pick<PullRequestDetail, "state" | "checks" | "mergeability" | "url">,
): PullRequestStanding => {
  const listed = detail.checks.filter((check) => check.placeholder !== true);
  const counted = listed.some((check) => check.required === true)
    ? listed.filter((check) => check.required === true)
    : listed;
  const failing = counted.some(
    (check) =>
      check.status === "failure" ||
      check.status === "cancelled" ||
      // Nothing moves it but a person, so a run waiting for it would wait for good.
      check.status === "action-required",
  );
  const pending = counted.some((check) => check.status === "pending");
  return {
    state: detail.state,
    // Pending first: the wait is for none of them still running, even once one has failed.
    checks: counted.length === 0 ? "none" : pending ? "pending" : failing ? "failing" : "passing",
    mergeability: detail.mergeability,
    url: detail.url,
  };
};

/** Whether a wait `until` this is over, the host having listed no checks for `withoutChecksMs`. */
export const isSettled = (
  until: PullRequestUntil,
  standing: PullRequestStanding,
  withoutChecksMs: number,
): boolean => {
  if (standing.state !== "open") return true;
  if (until !== "checks") return false;
  if (standing.checks === "none") return withoutChecksMs >= NO_CHECKS_AFTER_MS;
  return standing.checks !== "pending";
};

export interface IssueQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: IssueListState | undefined;
  /** Label names an issue must carry, every one of them. */
  readonly labels?: ReadonlyArray<string> | undefined;
  /** Free text the tracker matches itself. */
  readonly query?: string | undefined;
  readonly assignee?: string | undefined;
  readonly sort?: "updated" | "created" | undefined;
  readonly limit?: number | undefined;
}
export interface PullRequestQuery {
  readonly project: string;
  /** Defaults to open. */
  readonly state?: PullRequestListState | undefined;
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

type PullRequestSeen = Parameters<typeof pullRequestReference>[1];
/** A pull request as a run's reference, under the key every way of naming it shares. */
export const pullRequestReferenceOf = (
  ref: Pick<PullRequestRef, "projectId" | "host" | "repository" | "number">,
  seen?: PullRequestSeen,
) =>
  pullRequestReference(
    {
      projectId: ref.projectId,
      ...normalizeThreadPullRequestKey({
        host: ref.host ?? "",
        repository: ref.repository,
        number: ref.number,
        ...(seen?.url === undefined ? {} : { url: seen.url }),
      }),
    },
    seen,
  );

/** The pull requests linked to a thread from `sinceMillis` on, as references of its step. */
export const linkedPullRequestReferences = (
  thread: Parameters<typeof threadPullRequestsOf>[0] & { readonly projectId: ProjectId },
  sinceMillis: number | undefined,
) =>
  threadPullRequestsOf(thread)
    .filter(
      (link) =>
        link.source !== "stack-dismissed" &&
        (sinceMillis === undefined || Date.parse(link.linkedAt) >= sinceMillis),
    )
    .map((link) =>
      pullRequestReferenceOf(
        {
          projectId: thread.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        },
        link.snapshot === null
          ? { url: link.url }
          : { url: link.url, title: link.snapshot.title, state: link.snapshot.state },
      ),
    );

/**
 * What `subject` and `runs({ subject })` take: an issue or a pull request as a trigger or a
 * listing gave it, `{ threadId }`, or a web address.
 */
export type SubjectInput =
  | string
  | (Pick<Issue, "projectId" | "tracker" | "host" | "scope" | "key"> & {
      readonly title?: string;
      readonly url?: string;
    })
  | (Pick<PullRequest, "projectId" | "host" | "repository" | "number"> & {
      readonly title?: string;
      readonly url?: string;
    })
  | { readonly threadId: string };

const SUBJECT_EXAMPLE =
  "an issue or pull request a trigger or listing gave, { threadId }, or a web address";

const decodeSubjectIssue = Schema.decodeUnknownOption(
  Schema.Struct({ ...IssueRef.fields, host: TrimmedNonEmptyString }),
);
const decodeSubjectPullRequest = Schema.decodeUnknownOption(
  Schema.Struct({
    projectId: ProjectId,
    host: TrimmedNonEmptyString,
    repository: TrimmedNonEmptyString,
    number: PositiveInt,
  }),
);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * A subject as the reference it is kept and found by. Throws for anything else: a workflow file
 * is not type-checked, and a subject that names nothing would be a run no one can find.
 */
export const subjectReference = (what: string, subject: SubjectInput) => {
  if (typeof subject === "string") {
    if (!URL.canParse(subject) || !/^https?:$/.test(new URL(subject).protocol)) {
      throw new Error(`${what} takes ${SUBJECT_EXAMPLE}; "${subject}" is not a web address.`);
    }
    return {
      kind: WorkflowReferenceKind.url,
      key: subject,
      address: { url: subject },
      title: "",
      url: subject,
    } satisfies ReferenceInput;
  }
  if (typeof subject !== "object" || subject === null || Array.isArray(subject)) {
    throw new Error(`${what} takes ${SUBJECT_EXAMPLE}.`);
  }
  const seen = {
    ...("title" in subject && nonEmpty(subject.title) ? { title: subject.title } : {}),
    ...("url" in subject && nonEmpty(subject.url) ? { url: subject.url } : {}),
  };
  // Decoded, not trusted: an item's own view finds its runs by project and host, so a subject
  // kept without either would be a run that view never lists.
  if ("repository" in subject && "number" in subject) {
    const pullRequest = Option.getOrUndefined(decodeSubjectPullRequest(subject));
    if (pullRequest === undefined) {
      throw new Error(
        `${what} takes ${SUBJECT_EXAMPLE}; a pull request needs its projectId, host, repository and number.`,
      );
    }
    return pullRequestReferenceOf(pullRequest, seen);
  }
  if ("tracker" in subject && "key" in subject) {
    const issue = Option.getOrUndefined(decodeSubjectIssue(subject));
    if (issue === undefined) {
      throw new Error(
        `${what} takes ${SUBJECT_EXAMPLE}; an issue needs its projectId, tracker, host, scope and key.`,
      );
    }
    return { ...issueReference(issue), ...seen } satisfies ReferenceInput;
  }
  if ("threadId" in subject && nonEmpty(subject.threadId)) {
    return {
      kind: WorkflowReferenceKind.thread,
      key: subject.threadId,
      address: { threadId: subject.threadId },
      title: "",
    } satisfies ReferenceInput;
  }
  throw new Error(`${what} takes ${SUBJECT_EXAMPLE}.`);
};

export class WorkflowForge extends Context.Service<
  WorkflowForge,
  {
    readonly issues: {
      readonly list: (query: IssueQuery) => Effect.Effect<ReadonlyArray<Issue>, WorkflowForgeError>;
      readonly read: (issue: IssueAddress) => Effect.Effect<IssueDetail, WorkflowForgeError>;
      readonly comment: (
        issue: IssueAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly setState: (
        issue: IssueAddress,
        state: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly create: (input: {
        readonly project: string;
        readonly title: string;
        readonly body?: string | undefined;
        readonly labels?: ReadonlyArray<string> | undefined;
        readonly assignees?: ReadonlyArray<string> | undefined;
      }) => Effect.Effect<IssueCreateResult, WorkflowForgeError>;
    };
    readonly pullRequests: {
      readonly list: (
        query: PullRequestQuery,
      ) => Effect.Effect<ReadonlyArray<PullRequest>, WorkflowForgeError>;
      readonly read: (
        pullRequest: PullRequestAddress,
      ) => Effect.Effect<PullRequestDetail, WorkflowForgeError>;
      readonly comment: (
        pullRequest: PullRequestAddress,
        body: string,
      ) => Effect.Effect<void, WorkflowForgeError>;
      readonly act: (
        pullRequest: PullRequestAddress,
        action: PullRequestAction,
        options?: { readonly mergeMethod?: PullRequestMergeMethod | undefined },
      ) => Effect.Effect<void, WorkflowForgeError>;
    };
  }
>()("@j1code/server/workflows/WorkflowForge") {}

const failed =
  (what: string) =>
  (cause: unknown): WorkflowForgeError =>
    new WorkflowForgeError({
      reason: `${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

const missing = (what: string) => () =>
  Effect.fail(
    new WorkflowForgeError({
      reason: `${what} are not available to workflows on this server.`,
    }),
  );
/** For an engine with no trackers behind it: every call says so. */
export const unavailable = WorkflowForge.of({
  issues: {
    list: missing("Issues"),
    read: missing("Issues"),
    comment: missing("Issues"),
    setState: missing("Issues"),
    create: missing("Issues"),
  },
  pullRequests: {
    list: missing("Pull requests"),
    read: missing("Pull requests"),
    comment: missing("Pull requests"),
    act: missing("Pull requests"),
  },
});

export const layerPullRequests = Layer.effect(
  WorkflowForge,
  Effect.gen(function* () {
    const service = yield* PullRequestService.PullRequestService;
    const projects = yield* ProjectService.ProjectService;
    const projectIdOf = Effect.fn("WorkflowForge.projectIdOf")(function* (project: string) {
      if (!isProjectPath(project)) return ProjectId.make(project);
      const found = yield* projects
        .getByWorkspaceRoot(project)
        .pipe(Effect.mapError(failed("Could not read the project")));
      if (Option.isNone(found)) {
        return yield* new WorkflowForgeError({ reason: `No project is registered at ${project}.` });
      }
      return found.value.id;
    });
    const pullRequestRef = Effect.fn("WorkflowForge.pullRequestRef")(function* (
      address: PullRequestAddress,
    ) {
      if (!("project" in address)) {
        return {
          projectId: address.projectId,
          host: address.host,
          repository: address.repository,
          number: address.number,
        } satisfies PullRequestRef;
      }
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(address.url)?.link;
      if (parsed === undefined) {
        return yield* new WorkflowForgeError({ reason: "Expected a pull request URL." });
      }
      const key = normalizeThreadPullRequestKey(parsed);
      return { projectId: yield* projectIdOf(address.project), ...key } satisfies PullRequestRef;
    });
    const seenOf = (address: PullRequestAddress): PullRequestSeen => ({
      ...("title" in address && nonEmpty(address.title) ? { title: address.title } : {}),
      ...("url" in address && nonEmpty(address.url) ? { url: address.url } : {}),
    });
    return WorkflowForge.of({
      issues: unavailable.issues,
      pullRequests: {
        list: Effect.fn("WorkflowForge.pullRequests.list")(function* (query) {
          const result = yield* service
            .list({
              projectId: yield* projectIdOf(query.project),
              state: query.state ?? "open",
              ...(query.query === undefined ? {} : { query: query.query }),
              ...(query.limit === undefined ? {} : { limit: query.limit }),
            })
            .pipe(Effect.mapError(failed("Could not list pull requests")));
          const problem = result.errors[0];
          if (result.entries.length === 0 && problem !== undefined) {
            return yield* new WorkflowForgeError({
              reason: `Could not list pull requests: ${problem.message}`,
            });
          }
          return result.entries;
        }),
        read: Effect.fn("WorkflowForge.pullRequests.read")(function* (address) {
          const ref = yield* pullRequestRef(address);
          const detail = yield* service
            .detail({ ...ref, allowStale: false })
            .pipe(Effect.mapError(failed("Could not read the pull request")));
          yield* noteReference(pullRequestReferenceOf(ref, detail));
          return detail;
        }),
        comment: Effect.fn("WorkflowForge.pullRequests.comment")(function* (address, body) {
          const ref = yield* pullRequestRef(address);
          yield* service
            .comment({ ...ref, body })
            .pipe(Effect.mapError(failed("Could not comment on the pull request")));
          yield* noteReference(pullRequestReferenceOf(ref, seenOf(address)));
        }),
        act: Effect.fn("WorkflowForge.pullRequests.act")(function* (address, action, options) {
          const ref = yield* pullRequestRef(address);
          yield* service
            .runAction({
              ...ref,
              action,
              ...(options?.mergeMethod === undefined ? {} : { mergeMethod: options.mergeMethod }),
            })
            .pipe(Effect.mapError(failed(`Could not ${action} the pull request`)));
          yield* noteReference(pullRequestReferenceOf(ref, seenOf(address)));
        }),
      },
    });
  }),
);
