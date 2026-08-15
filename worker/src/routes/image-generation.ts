import { Env, AuthContext } from "../types";
import { jsonResponse, safeRequestJson } from "../utils";
import { verifyWorkflowRuntimeConfigToken } from "../services/github";
import { resolveCloudflareImageModel } from "../services/cloudflare-ai";

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampDimension(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(2048, Math.max(256, Math.floor(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function runImageModel(env: Env, model: string, prompt: string, width: number, height: number): Promise<unknown> {
  try {
    return await env.AI!.run(model, { prompt, width, height });
  } catch (firstError) {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    const serialized = new Response(form);
    try {
      return await env.AI!.run(model, {
        multipart: {
          body: serialized.body,
          contentType: serialized.headers.get("content-type") || "multipart/form-data",
        },
      });
    } catch {
      throw firstError;
    }
  }
}

function imageResponse(result: unknown): Response | null {
  if (result instanceof Response) return result;
  if (result instanceof ArrayBuffer) {
    return new Response(result, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  if (result instanceof Uint8Array) {
    return new Response(result, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  if (result instanceof ReadableStream) {
    return new Response(result, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
  }
  const record = asRecord(result);
  const nested = asRecord(record.result);
  const image = nested.image || record.image;
  if (image instanceof Uint8Array || image instanceof ArrayBuffer || image instanceof ReadableStream) {
    return imageResponse(image);
  }
  return null;
}

export async function handleImageGenerationSceneRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  if (!env.AI) return jsonResponse({ success: false, error: "Cloudflare AI binding is not configured" }, 503);

  const body = await safeRequestJson<Record<string, unknown>>(request);
  if (!body) return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
  const jobId = Number.parseInt(String(body.job_id || ""), 10);
  const token = readString(body.token);
  if (!Number.isFinite(jobId) || jobId < 1 || !token) {
    return jsonResponse({ success: false, error: "job_id and token are required" }, 400);
  }

  const job = await env.DB.prepare("SELECT id, user_id FROM jobs WHERE id = ? LIMIT 1").bind(jobId).first<{ id: number; user_id: number }>();
  if (!job?.id || !job.user_id) return jsonResponse({ success: false, error: "Job not found" }, 404);
  const githubSettings = await env.DB.prepare("SELECT pat_token FROM settings_github WHERE user_id = ? LIMIT 1").bind(job.user_id).first<{ pat_token: string | null }>();
  if (!githubSettings?.pat_token || !(await verifyWorkflowRuntimeConfigToken(job.id, token, githubSettings.pat_token))) {
    return jsonResponse({ success: false, error: "Invalid or expired runner token" }, 403);
  }

  const prompt = readString(body.prompt);
  if (!prompt) return jsonResponse({ success: false, error: "prompt is required" }, 400);
  const model = resolveCloudflareImageModel(body.image_model);
  const width = clampDimension(body.width, 1024);
  const height = clampDimension(body.height, 1024);

  try {
    const result = await runImageModel(env, model, prompt.slice(0, 4000), width, height);
    const response = imageResponse(result);
    if (!response) return jsonResponse({ success: false, error: "Image model did not return image bytes" }, 502);
    return response;
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Image generation failed" }, 502);
  }
}

export function imageGenerationRouteMarker(_auth: AuthContext): true {
  return true;
}
