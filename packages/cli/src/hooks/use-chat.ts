import { useEffect, useMemo, useRef } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import {
  type ModeType,
  type SupportedChatModelId,
  type ToolContracts,
} from "@devcode/shared";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { executeLocalTool } from "../lib/local-tools";
import { useBashApproval } from "./use-bash-approval";

// Same limit the server used to enforce with `stopWhen: stepCountIs(50)`.
const MAX_AUTOMATIC_STEPS = 50;

// Sent back to the model as the tool error, so it stops instead of retrying
// the same command or trying to get around the refusal another way.
const BASH_DENIED_MESSAGE =
  "The user declined to run this command. Do not retry it or run an equivalent command. Ask the user how they would like to proceed.";

export type ChatMessageMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

export function useChat(sessionId: string, initialMessages: Message[]) {
  const { requestApproval } = useBashApproval();
  // A tool can finish after the user has left the session. Reporting its
  // output then would make the SDK send a new request for a closed chat.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const transport = useMemo(() => {
    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),
      headers() {
        const auth = getAuth();
        return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
      },
      prepareSendMessagesRequest({ messages }) {
        const message = messages[messages.length - 1];
        if (!message) throw new Error("No message to send");

        const metadata = messages.findLast(
          (m) => m.metadata?.mode && m.metadata?.model,
        )?.metadata;
        const previousMessage = messages[messages.length - 2];
        const requestMessages =
          message.role === "assistant" && previousMessage?.role === "user"
            ? [previousMessage, message]
            : [message];

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: message.metadata?.mode ?? metadata?.mode,
            model: message.metadata?.model ?? metadata?.model,
          },
        };
      },
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onToolCall({ toolCall }) {
      const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";
      const tool = toolCall.toolName as keyof ChatTools;

      // Not awaited: the SDK doesn't wait on onToolCall, and the approval
      // prompt may stay open for as long as the user takes to decide.
      void (async () => {
        if (tool === "bash" && !(await requestApproval(toolCall.input))) {
          throw new Error(BASH_DENIED_MESSAGE);
        }
        return executeLocalTool(tool, toolCall.input, mode);
      })().then(
        (output) => {
          if (!isMountedRef.current) return;
          return chat.addToolOutput({
            tool,
            toolCallId: toolCall.toolCallId,
            output,
          });
        },
        (error) => {
          if (!isMountedRef.current) return;
          return chat.addToolOutput({
            tool,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
    sendAutomaticallyWhen({ messages }) {
      if (!lastAssistantMessageIsCompleteWithToolCalls({ messages })) {
        return false;
      }

      // Every server round trip adds a `step-start` part to the assistant
      // message. Cap them so a model stuck in a tool loop can't keep spending
      // credits forever; the user can type "continue" to go further.
      const lastMessage = messages.at(-1);
      const steps =
        lastMessage?.parts.filter((part) => part.type === "step-start")
          .length ?? 0;
      return steps < MAX_AUTOMATIC_STEPS;
    },
  });

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    submit: (params: {
      userText: string;
      mode: ModeType;
      model: SupportedChatModelId;
    }) => {
      return chat.sendMessage({
        text: params.userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      });
    },
    abort: chat.stop,
    interrupt: chat.stop,
  };
}
