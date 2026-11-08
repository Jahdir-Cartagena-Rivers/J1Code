import { useStore, type Message } from "@/state/store";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { ELEVATED_CARD } from "./elevated";

/** The original approval controls live with the request they answer. */
export function TranscriptApproval({
  message,
  botId,
  threadId,
  groupId,
}: {
  message: Message;
  botId: string;
  threadId: string;
  groupId?: string;
}) {
  const { state, dispatch } = useStore();
  const pending = pendingApprovals([message])[0];
  if (!pending) return null;
  const bot = state.bots.find(
    (item) => item.id === (message.inbox?.from.botId ?? message.from?.botId ?? botId),
  );
  const group = groupId ?? state.groups.find((item) => item.threadId === threadId)?.id;
  const cancel = () =>
    group
      ? dispatch({ type: "interruptGroup", groupId: group, threadId })
      : dispatch({ type: "interrupt", botId: bot?.id ?? botId, threadId });
  return (
    <div className={`w-full max-w-[560px] rounded-[24px] ${ELEVATED_CARD}`}>
      <PendingApprovalPanel
        pending={pending}
        botName={bot?.name}
        asker={bot}
        count={1}
        index={0}
        actions={
          <PendingApprovalActions
            part="primary"
            pending={pending}
            threadId={threadId}
            bot={bot}
            onCancelTurn={cancel}
          />
        }
        more={
          message.inbox ? undefined : (
            <PendingApprovalActions
              part="more"
              pending={pending}
              threadId={threadId}
              bot={bot}
              onCancelTurn={cancel}
            />
          )
        }
      />
    </div>
  );
}
