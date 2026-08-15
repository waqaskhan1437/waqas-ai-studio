import type { AIModelOption, AIModelCatalogResponse, AIProviderCatalog, CloudflareVisualCatalog, CloudflareVisualModel } from "./types";

function stringFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return stringFromUnknown(record.id)
      || stringFromUnknown(record.value)
      || stringFromUnknown(record.name)
      || stringFromUnknown(record.label)
      || stringFromUnknown(record.displayName);
  }
  return "";
}

function labelFromUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return labelFromUnknown(record.label)
      || labelFromUnknown(record.displayName)
      || labelFromUnknown(record.name)
      || labelFromUnknown(record.id)
      || fallback;
  }
  return fallback;
}

function normalizeModel(model: unknown): AIModelOption | null {
  const id = stringFromUnknown(model).trim();
  if (!id) return null;

  if (typeof model === "string") {
    return { id, label: id };
  }

  const record = model && typeof model === "object" ? model as Record<string, unknown> : {};
  const tier = record.tier === "free" || record.tier === "paid" || record.tier === "unknown"
    ? record.tier
    : undefined;
  const contextWindow = typeof record.contextWindow === "number"
    ? record.contextWindow
    : typeof record.context_window === "number"
      ? record.context_window
      : null;

  return {
    id,
    label: labelFromUnknown(record.label, id),
    description: typeof record.description === "string" ? record.description : undefined,
    tier,
    contextWindow,
  };
}

function normalizeProvider(provider: unknown): AIProviderCatalog | null {
  if (!provider || typeof provider !== "object") return null;
  const record = provider as Record<string, unknown>;
  const id = stringFromUnknown(record.id).trim();
  if (!id) return null;
  const rawModels = Array.isArray(record.models) ? record.models : [];
  const models = rawModels
    .map(normalizeModel)
    .filter((model): model is AIModelOption => Boolean(model));

  return {
    id,
    label: labelFromUnknown(record.label, id),
    models,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

function normalizeCloudflareVisualCatalog(value: unknown): CloudflareVisualCatalog | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const normalizeVisualModels = (raw: unknown, task: "image" | "video"): CloudflareVisualModel[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        id: stringFromUnknown(item.id).trim(),
        label: labelFromUnknown(item.label, stringFromUnknown(item.id)),
        task,
        description: typeof item.description === "string" ? item.description : undefined,
        experimental: item.experimental === true,
      }))
      .filter((item) => item.id);
  };

  const image_models = normalizeVisualModels(record.image_models, "image");
  const video_models = normalizeVisualModels(record.video_models, "video");
  if (image_models.length === 0 && video_models.length === 0) return undefined;
  return {
    provider: "cloudflare",
    image_models,
    video_models,
    image_model_count: image_models.length,
    video_model_count: video_models.length,
    source: typeof record.source === "string" ? record.source : undefined,
  };
}

export function normalizeAiCatalog(catalog: unknown): AIModelCatalogResponse {
  const record = catalog && typeof catalog === "object" ? catalog as Record<string, unknown> : {};
  const rawProviders = Array.isArray(record.providers) ? record.providers : [];
  const providers = rawProviders
    .map(normalizeProvider)
    .filter((provider): provider is AIProviderCatalog => Boolean(provider));
  const defaultProvider = stringFromUnknown(record.default_provider) || null;

  return {
    default_provider: defaultProvider,
    providers,
    cloudflare_visual: normalizeCloudflareVisualCatalog(record.cloudflare_visual),
  };
}

export function getAvailableProviders(catalog: AIModelCatalogResponse | null): AIProviderCatalog[] {
  return normalizeAiCatalog(catalog).providers;
}

export function getProviderModels(
  catalog: AIModelCatalogResponse | null,
  providerId: string | null | undefined
): AIModelOption[] {
  if (!providerId) return [];
  return getAvailableProviders(catalog).find((provider) => provider.id === providerId)?.models || [];
}

export function resolveProviderSelection(
  catalog: AIModelCatalogResponse | null,
  preferred: string | null | undefined
): string {
  const providers = getAvailableProviders(catalog);
  const preferredId = stringFromUnknown(preferred);
  if (preferredId && providers.some((provider) => provider.id === preferredId)) {
    return preferredId;
  }

  const defaultProvider = stringFromUnknown(catalog?.default_provider);
  if (defaultProvider && providers.some((provider) => provider.id === defaultProvider)) {
    return defaultProvider;
  }

  return providers[0]?.id || "";
}

export function resolveModelSelection(
  catalog: AIModelCatalogResponse | null,
  providerId: string | null | undefined,
  preferred: string | null | undefined
): string {
  const provider = stringFromUnknown(providerId);
  const models = getProviderModels(catalog, provider);
  const preferredId = stringFromUnknown(preferred);
  if (preferredId && models.some((model) => model.id === preferredId)) {
    return preferredId;
  }
  return models[0]?.id || "";
}
