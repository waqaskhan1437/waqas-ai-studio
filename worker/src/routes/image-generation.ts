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
  const runMultipart = async (): Promise<unknown> => {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    const serialized = new Response(form);
    return env.AI!.run(model, {
      multipart: {
        body: serialized.body,
        contentType: serialized.headers.get("content-type") || "multipart/form-data",
      },
    });
  };

  const requiresMultipart = model === "@cf/black-forest-labs/flux-2-klein-9b"
    || model === "@cf/black-forest-labs/flux-2-klein-4b"
    || model === "@cf/black-forest-labs/flux-2-dev";
  if (requiresMultipart) return runMultipart();

  try {
    return await env.AI!.run(model, { prompt, width, height });
  } catch (firstError) {
    try {
      return await runMultipart();
    } catch {
      throw firstError;
    }
  }
}

async function imageStringResponse(value: string): Promise<Response | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    const fetched = await fetch(trimmed);
    return fetched.ok ? new Response(fetched.body, { status: fetched.status, headers: { "Content-Type": fetched.headers.get("content-type") || "image/png", "Cache-Control": "no-store" } }) : null;
  }
  const payload = trimmed.replace(/^data:image\/[^;]+;base64,/i, "");
  try {
    const binary = atob(payload);
    if (binary.length < 1000) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const contentType = bytes[0] === 0xff && bytes[1] === 0xd8
      ? "image/jpeg"
      : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        ? "image/png"
        : bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
          ? "image/webp"
          : "image/png";
    return new Response(bytes, { headers: { "Content-Type": contentType, "Cache-Control": "no-store" } });
  } catch {
    return null;
  }
}

async function imageResponse(result: unknown): Promise<Response | null> {
  const imageHeaders = { "Content-Type": "image/png", "Cache-Control": "no-store" };
  if (typeof result === "string") return imageStringResponse(result);
  if (result instanceof Response) return new Response(result.body, { status: result.status, headers: imageHeaders });
  if (result instanceof ArrayBuffer) return new Response(result, { headers: imageHeaders });
  if (ArrayBuffer.isView(result)) return new Response(result as ArrayBufferView<ArrayBuffer>, { headers: imageHeaders });
  if (result && typeof result === "object" && typeof (result as { byteLength?: unknown }).byteLength === "number") {
    const byteLength = Number((result as { byteLength: number }).byteLength);
    if (byteLength > 0) return new Response(result as BodyInit, { headers: imageHeaders });
  }
  if (result instanceof Blob) return new Response(result, { headers: { ...imageHeaders, "Content-Type": result.type || "image/png" } });
  if (result instanceof ReadableStream) return new Response(result, { headers: imageHeaders });

  if (result && typeof result === "object") {
    const structural = result as { body?: unknown; arrayBuffer?: () => Promise<ArrayBuffer> };
    if (structural.body instanceof ReadableStream) return new Response(structural.body, { headers: imageHeaders });
    if (typeof structural.arrayBuffer === "function") {
      return new Response(await structural.arrayBuffer(), { headers: imageHeaders });
    }
    if (structural.body && typeof (structural.body as { getReader?: unknown }).getReader === "function") {
      return new Response(structural.body as ReadableStream, { headers: imageHeaders });
    }
  }

  const record = asRecord(result);
  const nested = asRecord(record.result);
  const image = nested.image || record.image || nested.image_bytes || record.image_bytes || nested.output || record.output;
  if (image !== undefined) return imageResponse(image);

  const base64Image = nested.image_base64 || record.image_base64;
  if (typeof base64Image === "string" && base64Image) {
    const binary = atob(base64Image.replace(/^data:image\/[^;]+;base64,/, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Response(bytes, { headers: imageHeaders });
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
    const response = await imageResponse(result);
    if (!response) return jsonResponse({ success: false, error: "Image model did not return image bytes" }, 502);
    return response;
  } catch (error) {
    return jsonResponse({ success: false, error: error instanceof Error ? error.message : "Image generation failed" }, 502);
  }
}

export function imageGenerationRouteMarker(_auth: AuthContext): true {
  return true;
}
