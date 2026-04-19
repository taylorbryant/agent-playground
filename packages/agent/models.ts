import {
  createGateway,
  defaultSettingsMiddleware,
  gateway as aiGateway,
  wrapLanguageModel,
  type GatewayModelId,
  type JSONValue,
  type LanguageModel,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";

function supportsAdaptiveAnthropicThinking(modelId: string): boolean {
  return modelId.includes("4.6") || modelId.includes("4.7");
}

// Models with adaptive thinking support use effort control.
// Older models use the legacy extended thinking API with a budget.
function getAnthropicSettings(modelId: string): AnthropicLanguageModelOptions {
  if (supportsAdaptiveAnthropicThinking(modelId)) {
    return {
      effort: "medium",
      thinking: { type: "adaptive" },
    } satisfies AnthropicLanguageModelOptions;
  }

  return {
    thinking: { type: "enabled", budgetTokens: 8000 },
  };
}

function isJsonObject(value: unknown): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProviderOptionsRecord(
  options: Record<string, unknown>,
): Record<string, JSONValue> {
  return options as Record<string, JSONValue>;
}

function mergeRecords(
  base: Record<string, JSONValue>,
  override: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const merged: Record<string, JSONValue> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existingValue = merged[key];

    if (isJsonObject(existingValue) && isJsonObject(value)) {
      merged[key] = mergeRecords(existingValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export type ProviderOptionsByProvider = Record<
  string,
  Record<string, JSONValue>
>;

export function mergeProviderOptions(
  defaults: ProviderOptionsByProvider,
  overrides?: ProviderOptionsByProvider,
): ProviderOptionsByProvider {
  if (!overrides || Object.keys(overrides).length === 0) {
    return defaults;
  }

  const merged: ProviderOptionsByProvider = { ...defaults };

  for (const [provider, providerOverrides] of Object.entries(overrides)) {
    const providerDefaults = merged[provider];

    if (!providerDefaults) {
      merged[provider] = providerOverrides;
      continue;
    }

    merged[provider] = mergeRecords(providerDefaults, providerOverrides);
  }

  return merged;
}

export interface GatewayConfig {
  baseURL: string;
  apiKey: string;
}

export interface GatewayOptions {
  config?: GatewayConfig;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

export interface AvailableModelDescriptor {
  id: GatewayModelId;
  name: string;
  modelType: "language";
}

type DirectLanguageModel =
  | ReturnType<ReturnType<typeof createOpenAI>>
  | ReturnType<ReturnType<typeof createAnthropic>>;

export type { GatewayModelId, LanguageModel, JSONValue };

function isLocalModeEnabled(): boolean {
  return (
    process.env.OPEN_HARNESS_LOCAL_MODE === "1" ||
    process.env.NEXT_PUBLIC_OPEN_HARNESS_LOCAL_MODE === "1"
  );
}

function getConfiguredLocalModelIds(): GatewayModelId[] {
  const configured = process.env.OPEN_HARNESS_LOCAL_MODELS?.split(",")
    .map((value) => value.trim())
    .filter((value): value is GatewayModelId => value.length > 0);

  if (configured && configured.length > 0) {
    return configured;
  }

  const defaults: GatewayModelId[] = [];

  if (process.env.OPENAI_API_KEY) {
    defaults.push("openai/gpt-5.4");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    defaults.push("anthropic/claude-haiku-4.5");
  }

  return defaults;
}

function formatModelName(modelId: string): string {
  const [, rawName = modelId] = modelId.split("/", 2);
  return rawName
    .split(/[-_]/g)
    .filter((part) => part.length > 0)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

export function getDirectProviderAvailableModels(): AvailableModelDescriptor[] {
  if (!isLocalModeEnabled()) {
    return [];
  }

  return getConfiguredLocalModelIds().map((id) => ({
    id,
    name: formatModelName(id),
    modelType: "language",
  }));
}

function getDirectProviderModel(
  modelId: GatewayModelId,
): DirectLanguageModel | null {
  if (!isLocalModeEnabled()) {
    return null;
  }

  const [provider, modelName] = modelId.split("/", 2);
  if (!provider || !modelName) {
    return null;
  }

  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return createOpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })(modelName);
  }

  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })(modelName);
  }

  return null;
}

export function shouldApplyOpenAIReasoningDefaults(modelId: string): boolean {
  return modelId.startsWith("openai/gpt-5");
}

function shouldApplyOpenAITextVerbosityDefaults(modelId: string): boolean {
  return modelId.startsWith("openai/gpt-5.4");
}

export function getProviderOptionsForModel(
  modelId: string,
  providerOptionsOverrides?: ProviderOptionsByProvider,
): ProviderOptionsByProvider {
  const defaultProviderOptions: ProviderOptionsByProvider = {};

  // Apply anthropic defaults
  if (modelId.startsWith("anthropic/")) {
    defaultProviderOptions.anthropic = toProviderOptionsRecord(
      getAnthropicSettings(modelId),
    );
  }

  // OpenAI model responses should never be persisted.
  if (modelId.startsWith("openai/")) {
    defaultProviderOptions.openai = toProviderOptionsRecord({
      store: false,
    } satisfies OpenAIResponsesProviderOptions);
  }

  // Apply OpenAI defaults for all GPT-5 variants to expose encrypted reasoning content.
  // This avoids Responses API failures when `store: false`, e.g.:
  // "Item with id 'rs_...' not found. Items are not persisted when `store` is set to false."
  if (shouldApplyOpenAIReasoningDefaults(modelId)) {
    defaultProviderOptions.openai = mergeRecords(
      defaultProviderOptions.openai ?? {},
      toProviderOptionsRecord({
        reasoningSummary: "detailed",
        include: ["reasoning.encrypted_content"],
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  if (shouldApplyOpenAITextVerbosityDefaults(modelId)) {
    defaultProviderOptions.openai = mergeRecords(
      defaultProviderOptions.openai ?? {},
      toProviderOptionsRecord({
        textVerbosity: "low",
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  const providerOptions = mergeProviderOptions(
    defaultProviderOptions,
    providerOptionsOverrides,
  );

  // Enforce OpenAI non-persistence even when custom provider overrides are present.
  if (modelId.startsWith("openai/")) {
    providerOptions.openai = mergeRecords(
      providerOptions.openai ?? {},
      toProviderOptionsRecord({
        store: false,
      } satisfies OpenAIResponsesProviderOptions),
    );
  }

  return providerOptions;
}

export function gateway(
  modelId: GatewayModelId,
  options: GatewayOptions = {},
): LanguageModel {
  const { config, providerOptionsOverrides } = options;

  const directModel = getDirectProviderModel(modelId);
  if (directModel && !config) {
    let model = directModel;
    const providerOptions = getProviderOptionsForModel(
      modelId,
      providerOptionsOverrides,
    );

    if (Object.keys(providerOptions).length > 0) {
      model = wrapLanguageModel({
        model,
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions },
        }),
      });
    }

    return model as LanguageModel;
  }

  // Use custom gateway config or default AI SDK gateway
  const baseGateway = config
    ? createGateway({ baseURL: config.baseURL, apiKey: config.apiKey })
    : aiGateway;

  let model: LanguageModel = baseGateway(modelId);

  const providerOptions = getProviderOptionsForModel(
    modelId,
    providerOptionsOverrides,
  );

  if (Object.keys(providerOptions).length > 0) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions },
      }),
    });
  }

  return model;
}
