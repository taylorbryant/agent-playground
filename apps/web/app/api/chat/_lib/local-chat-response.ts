import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type LanguageModelUsage,
  pruneMessages,
} from "ai";
import type { OpenHarnessAgentCallOptions } from "@open-harness/agent";
import type {
  WebAgentMessageMetadata,
  WebAgentStepFinishMetadata,
  WebAgentUIMessage,
} from "@/app/types";
import { addLanguageModelUsage } from "@/app/workflows/usage-utils";
import { extractGatewayCost } from "@/app/workflows/gateway-metadata";
import { dedupeMessageReasoning } from "@/lib/chat/dedupe-message-reasoning";
import {
  compareAndSetChatActiveStreamId,
  createChatMessageIfNotExists,
  updateChatAssistantActivity,
} from "@/lib/db/sessions";
import {
  createLocalRunId,
  registerLocalRun,
  unregisterLocalRun,
} from "@/lib/chat/local-run-registry";

type WebAgentUIMessageChunk = InferUIMessageChunk<WebAgentUIMessage>;

function withModelMetadata(
  metadata: WebAgentMessageMetadata | undefined,
  selectedModelId: string,
  modelId: string,
): WebAgentMessageMetadata {
  return {
    ...metadata,
    selectedModelId,
    modelId,
  };
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.toLowerCase().includes("abort"))
  );
}

export async function createLocalChatStreamResponse(params: {
  chatId: string;
  messages: WebAgentUIMessage[];
  selectedModelId: string;
  modelId: string;
  agentOptions: OpenHarnessAgentCallOptions;
}) {
  const { webAgent } = await import("@/app/config");
  const runId = createLocalRunId();
  const abortController = new AbortController();
  const claimed = await compareAndSetChatActiveStreamId(
    params.chatId,
    null,
    runId,
  );

  if (!claimed) {
    return Response.json(
      { error: "Another workflow is already running for this chat" },
      { status: 409 },
    );
  }

  registerLocalRun(runId, params.chatId, abortController);

  const messageId = crypto.randomUUID();
  let responseMessage: WebAgentUIMessage | undefined;
  const modelMessages = await convertToModelMessages<WebAgentUIMessage>(
    params.messages.map(dedupeMessageReasoning),
    {
      ignoreIncompleteToolCalls: true,
      tools: webAgent.tools,
      convertDataPart: (part) => {
        if (part.type === "data-snippet") {
          const { filename, content } = part.data;
          return {
            type: "text" as const,
            text: `<snippet filename="${filename}">\n${content}\n</snippet>`,
          };
        }

        return undefined;
      },
    },
  );

  const result = await webAgent.stream({
    messages: pruneMessages({
      messages: modelMessages,
      emptyMessages: "remove",
    }),
    options: params.agentOptions,
    abortSignal: abortController.signal,
  });

  const stream = new ReadableStream<WebAgentUIMessageChunk>({
    async start(controller) {
      let totalMessageUsage: LanguageModelUsage | undefined;
      let totalMessageCost: number | undefined;
      let lastStepUsage: LanguageModelUsage | undefined;
      let lastStepCost: number | undefined;
      let stepFinishReasons: WebAgentStepFinishMetadata[] = [];

      try {
        for await (const part of result.toUIMessageStream<WebAgentUIMessage>({
          originalMessages: params.messages,
          generateMessageId: () => messageId,
          messageMetadata: ({ part: streamPart }) => {
            if (streamPart.type === "finish-step") {
              lastStepUsage = streamPart.usage;
              if (streamPart.usage) {
                totalMessageUsage = totalMessageUsage
                  ? addLanguageModelUsage(totalMessageUsage, streamPart.usage)
                  : streamPart.usage;
              }

              const stepCost = extractGatewayCost(streamPart.providerMetadata);
              if (stepCost !== undefined) {
                lastStepCost = stepCost;
                totalMessageCost = (totalMessageCost ?? 0) + stepCost;
              }

              stepFinishReasons = [
                ...stepFinishReasons,
                {
                  finishReason: streamPart.finishReason,
                  rawFinishReason: streamPart.rawFinishReason,
                },
              ];

              return {
                selectedModelId: params.selectedModelId,
                modelId: params.modelId,
                lastStepUsage,
                totalMessageUsage,
                lastStepCost,
                totalMessageCost,
                lastStepFinishReason: streamPart.finishReason,
                lastStepRawFinishReason: streamPart.rawFinishReason,
                stepFinishReasons,
              } satisfies WebAgentMessageMetadata;
            }

            return undefined;
          },
          onFinish: ({ responseMessage: finishedResponseMessage }) => {
            responseMessage = {
              ...finishedResponseMessage,
              metadata: withModelMetadata(
                finishedResponseMessage.metadata,
                params.selectedModelId,
                params.modelId,
              ),
            };
          },
        })) {
          controller.enqueue(part);
        }
      } catch (error) {
        if (!isAbortLikeError(error)) {
          controller.error(error);
        }
      } finally {
        unregisterLocalRun(runId);
        await compareAndSetChatActiveStreamId(params.chatId, runId, null);

        if (responseMessage) {
          const created = await createChatMessageIfNotExists({
            id: responseMessage.id,
            chatId: params.chatId,
            role: "assistant",
            parts: responseMessage,
          });

          if (created) {
            await updateChatAssistantActivity(params.chatId, new Date());
          }
        }

        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "x-workflow-run-id": runId,
    },
  });
}
