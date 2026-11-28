import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  createIdGenerator,
  isStepCount,
  streamText,
  validateUIMessages,
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { db } from "@devcode/database/client";
import type { Prisma } from "@devcode/database";
import {
  getToolContracts,
  modeSchema,
  type ModeType,
  type ToolContracts,
} from "@devcode/shared";
import { buildSystemPrompt } from "../system-prompt";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { requireCreditsBalance } from "../middleware/require-credits-balance";
import { calculateCreditsForUsage } from "../lib/credits";
import { ingestAiUsage } from "../lib/polar";
import { isSupportedChatModel, resolveChatModel } from "../lib/models";
import { compactOldSearchResults, createChatTools } from "../tools/web-search";

// Server-run tools (web search) need extra steps inside one request: search,
// read the results, then answer or search again. The loop still stops as soon
// as the model calls a local tool, because those have no `execute` here.
const MAX_SERVER_STEPS = 6;

type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type DevcodeUIMessage = UIMessage<
  ChatMessageMetadata,
  never,
  InferUITools<ToolContracts>
>;

const submitSchema = z.object({
  id: z.string(),
  messages: z
    .array(
      z.custom<DevcodeUIMessage>((value) => {
        return (
          value != null &&
          typeof value === "object" &&
          "id" in value &&
          "parts" in value
        );
      }),
    )
    .min(1),
  mode: modeSchema,
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
});

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

const generateAssistantMessageId = createIdGenerator({
  prefix: "msg",
  size: 16,
});

function hasPendingToolCalls(message: DevcodeUIMessage) {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }

    return false;
  });
}

const app = new Hono<AuthenticatedEnv>().post(
  "/",
  requireCreditsBalance,
  submitValidator,
  async (c) => {
    const userId = c.get("userId");
    const { id, messages, mode, model } = c.req.valid("json");

    const session = await db.session.findUnique({
      where: { id, userId },
    });

    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const startTime = Date.now();
    const toolContracts = getToolContracts(mode);
    const resolvedModel = resolveChatModel(model);
    const previousMessages = Array.isArray(session.messages)
      ? (session.messages as unknown as DevcodeUIMessage[])
      : [];
    const mergedMessages = [...previousMessages];

    for (const message of messages) {
      const incomingMessage = {
        ...message,
        metadata: { ...message.metadata, mode, model },
      } satisfies DevcodeUIMessage;

      const existingMessageIndex = mergedMessages.findIndex(
        (m) => m.id === incomingMessage.id,
      );

      if (existingMessageIndex === -1) {
        mergedMessages.push(incomingMessage);
      } else {
        mergedMessages[existingMessageIndex] = incomingMessage;
      }
    }

    const nextMessages = await validateUIMessages<DevcodeUIMessage>({
      messages: mergedMessages,
      tools: toolContracts,
    });
    const lastMessage = nextMessages.at(-1);
    const { tools, getSearchCredits } = createChatTools({
      mode,
      currentReply: lastMessage?.role === "assistant" ? lastMessage : undefined,
    });
    const modelMessages = await convertToModelMessages(
      compactOldSearchResults(nextMessages),
      { tools },
    );
    let completedUsage: LanguageModelUsage | null = null;
    const requestId = crypto.randomUUID();

    const result = streamText({
      model: resolvedModel.model,
      system: buildSystemPrompt({ mode }),
      messages: modelMessages,
      tools,
      stopWhen: isStepCount(MAX_SERVER_STEPS),
      providerOptions: resolvedModel.providerOptions,
      onFinish(event) {
        completedUsage = event.totalUsage;
      },
    });

    return result.toUIMessageStreamResponse<DevcodeUIMessage>({
      originalMessages: nextMessages,
      // Without this, a new assistant reply gets the id "" on the server
      // while the client invents its own, so saved history fills up with
      // duplicate "" ids. Generating it here sends the same id to the client.
      generateMessageId: generateAssistantMessageId,
      messageMetadata({ part }) {
        if (part.type === "start") {
          return { mode, model };
        }

        if (part.type !== "finish") return undefined;

        return {
          mode,
          model,
          durationMs: Date.now() - startTime,
          ...(completedUsage ? { usage: completedUsage } : {}),
        };
      },
      async onFinish(event) {
        if (event.isAborted) return;

        // Bill every finished request, including ones that stop to wait for a
        // client-side tool result. Each tool round trip is its own request
        // that used tokens, so billing only the final one would undercharge.
        try {
          const usage = completedUsage ?? (await result.totalUsage);
          const billableUsage = calculateCreditsForUsage({
            provider: resolvedModel.provider,
            model: resolvedModel.modelId,
            usage,
          });

          // One assistant message spans several requests, so the message id
          // alone is not unique. The request id keeps Polar's dedupe working
          // for retries of this request without merging separate requests.
          await ingestAiUsage({
            externalCustomerId: userId,
            eventId: `chat-request:${requestId}`,
            // Search fees aren't part of token usage, so add them separately.
            credits: billableUsage.credits + getSearchCredits(),
          });
        } catch (error) {
          console.error("Failed to ingest Polar AI usage for chat request", {
            error,
            sessionId: id,
            messageId: event.responseMessage.id,
            requestId,
            userId,
          });
        }

        // Only save once the turn is complete. A saved history that ends in
        // an unanswered tool call can't be sent to the model again.
        if (hasPendingToolCalls(event.responseMessage)) return;

        await db.session.update({
          where: { id, userId },
          data: {
            messages: event.messages as unknown as Prisma.InputJsonValue,
          },
        });
      },
      onError(error) {
        return error instanceof Error ? error.message : String(error);
      },
    });
  },
);

export default app;
