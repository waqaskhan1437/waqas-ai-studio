import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "iad1";

type GeminiBridgeRequest =
  | {
      action: "models";
      apiKey?: string;
    }
  | {
      action: "generate";
      apiKey?: string;
      model?: string;
      messages?: {
        system?: string;
        user?: string;
      };
    };

function errorResponse(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function getBridgeSecret(): string {
  return String(process.env.GEMINI_BRIDGE_SECRET || "").trim();
}

function getWorkerApiBaseUrl(): string {
  return String(process.env.NEXT_PUBLIC_API_URL || "https://waqas-ai-studio.waqaskhan1437.workers.dev").trim().replace(/\/+$/, "");
}

function getBearerToken(request: NextRequest): string {
  const header = request.headers.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function hasValidWorkerAuth(request: NextRequest): Promise<boolean> {
  const token = getBearerToken(request);
  if (!token) {
    return false;
  }

  try {
    const response = await fetch(`${getWorkerApiBaseUrl()}/api/me`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const expected = getBridgeSecret();
  if (expected && request.headers.get("x-gemini-bridge-secret") === expected) {
    return true;
  }

  return hasValidWorkerAuth(request);
}

function readApiKey(body: GeminiBridgeRequest): string {
  return String(body.apiKey || "").trim();
}

async function readProviderError(prefix: string, response: Response): Promise<never> {
  const errorText = (await response.text()).trim();
  throw new Error(errorText ? `${prefix}: ${response.status} ${errorText}` : `${prefix}: ${response.status}`);
}

function parseContextWindow(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchGeminiModels(apiKey: string) {
  const params = new URLSearchParams({ key: apiKey });
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${params.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    await readProviderError("Gemini models failed", response);
  }

  const payload = await response.json() as {
    models?: Array<{
      name: string;
      displayName?: string;
      description?: string;
      supportedGenerationMethods?: string[];
      inputTokenLimit?: number | string;
    }>;
  };

  return (payload.models || [])
    .filter((model) => (model.supportedGenerationMethods || []).includes("generateContent"))
    .map((model) => {
      const id = model.name.replace(/^models\//, "");
      return {
        id,
        label: model.displayName || id,
        description: model.description,
        contextWindow: parseContextWindow(model.inputTokenLimit),
      };
    });
}

async function generateWithGemini(
  apiKey: string,
  model: string,
  messages: { system?: string; user?: string }
) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `${String(messages.system || "").trim()}\n\n${String(messages.user || "").trim()}`.trim(),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.7,
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!response.ok) {
    await readProviderError("Gemini request failed", response);
  }

  const payload = await response.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no usable text");
  }

  return text;
}

export async function POST(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    const hasSecret = Boolean(getBridgeSecret());
    const hasWorkerToken = Boolean(getBearerToken(request));
    const message = hasSecret || hasWorkerToken
      ? "Unauthorized Gemini bridge request"
      : "Gemini bridge is not configured";
    return errorResponse(message, 401);
  }

  let body: GeminiBridgeRequest | null = null;
  try {
    body = await request.json() as GeminiBridgeRequest;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    return errorResponse("Invalid Gemini bridge payload", 400);
  }

  const apiKey = readApiKey(body);
  if (!apiKey) {
    return errorResponse("apiKey is required", 400);
  }

  try {
    if (body.action === "models") {
      const models = await fetchGeminiModels(apiKey);
      return NextResponse.json({ models }, { status: 200 });
    }

    if (body.action === "generate") {
      const model = String(body.model || "").trim();
      if (!model) {
        return errorResponse("model is required", 400);
      }

      const text = await generateWithGemini(apiKey, model, body.messages || {});
      return NextResponse.json({ text }, { status: 200 });
    }

    return errorResponse("Unsupported Gemini bridge action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini bridge request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
