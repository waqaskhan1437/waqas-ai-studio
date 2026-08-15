import { GithubSettings, WorkflowInputs } from "../types";
import { githubHeaders, sleep } from "../utils";

const WORKFLOW_NAME = "video-automation.yml";
const GITHUB_FETCH_TIMEOUT_MS = 15000;
const WORKER_WEBHOOK_URL = "https://waqas-ai-studio.waqaskhan1437.workers.dev/api/webhook/github";
const RUNTIME_CONFIG_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export interface DispatchResult {
  success: boolean;
  runId: number | null;
  runUrl: string | null;
  error?: string;
  warning?: string;
  dispatched?: boolean;
  pendingRunLookup?: boolean;
  payloadBytes?: number;
  dispatchStatus?: number;
  dispatchNonce?: string;
}



async function fetchGithubWithTimeout(url: string, init: RequestInit, timeoutMs: number = GITHUB_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function getWorkflowRunsUrl(githubSettings: GithubSettings, workflowFile: string): string {
  return `https://github.com/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/workflows/${workflowFile}`;
}

type GitHubWorkflowListItem = {
  id: number;
  name: string;
  path: string;
  state?: string;
};

function expectedWorkflowNames(workflowFile: string): string[] {
  if (workflowFile === "image-automation.yml") {
    return ["Image Automation Runner"];
  }
  if (workflowFile === "video-automation.yml") {
    return ["Video Automation Runner"];
  }
  return [];
}

function createDispatchNonce(jobId: number, automationId: number): string {
  const randomPart = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `job-${jobId}-automation-${automationId}-${Date.now()}-${randomPart}`;
}

function isMatchingWorkflowRun(
  run: { event?: string; display_title?: string; name?: string; created_at?: string },
  dispatchNonce: string,
  jobId: string,
  dispatchStartedAt: number
): boolean {
  if (run.event && run.event !== "workflow_dispatch") return false;
  const title = `${run.display_title || ""} ${run.name || ""}`;
  if (dispatchNonce && title.includes(dispatchNonce)) return true;

  // Fallback only when the run title explicitly includes this job id.
  // Never attach by "latest created_at" alone because that can map a new DB job
  // to another automation's GitHub run and corrupt logs/status diagnostics.
  if (jobId && new RegExp(`\\bjob\\s+${jobId}\\b`, "i").test(title)) {
    if (!run.created_at) return true;
    const createdAt = Date.parse(run.created_at);
    return Number.isFinite(createdAt) && createdAt >= dispatchStartedAt - 5000;
  }

  return false;
}

async function resolveWorkflowDispatchTarget(
  githubSettings: GithubSettings,
  workflowFile: string
): Promise<{ idOrFile: string; warning?: string }> {
  try {
    const workflowsUrl = `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/workflows?per_page=100`;
    const response = await fetchGithubWithTimeout(workflowsUrl, {
      headers: githubHeaders(githubSettings.pat_token),
    }, 12000);

    if (!response.ok) {
      const body = await response.text();
      return {
        idOrFile: workflowFile,
        warning: `Could not list GitHub workflows (${response.status}): ${body.substring(0, 240)}`,
      };
    }

    const data = await response.json() as { workflows?: GitHubWorkflowListItem[] };
    const workflows = Array.isArray(data.workflows) ? data.workflows : [];
    const names = expectedWorkflowNames(workflowFile);

    const match = workflows.find((workflow) => {
      const path = String(workflow.path || "");
      const name = String(workflow.name || "");
      return path.endsWith(`/${workflowFile}`) || path === workflowFile || names.includes(name);
    });

    if (!match) {
      const available = workflows
        .map((workflow) => `${workflow.name} (${workflow.path})`)
        .slice(0, 8)
        .join(", ");
      return {
        idOrFile: workflowFile,
        warning: `GitHub workflow ${workflowFile} was not found in the default branch. Available workflows: ${available || "none"}`,
      };
    }

    if (match.state && match.state !== "active") {
      return {
        idOrFile: String(match.id),
        warning: `GitHub workflow ${match.name} exists but state is ${match.state}. Enable it in GitHub Actions if dispatch still fails.`,
      };
    }

    return { idOrFile: String(match.id) };
  } catch (error) {
    return {
      idOrFile: workflowFile,
      warning: `Could not resolve GitHub workflow ID: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}


function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function createHmacSha256(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(signature);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left[index] ^ right[index];
  }

  return diff === 0;
}

export async function buildWorkflowRuntimeConfigToken(jobId: number, patToken: string): Promise<string> {
  const expiresAt = Date.now() + RUNTIME_CONFIG_TOKEN_TTL_MS;
  const payload = `${jobId}.${expiresAt}`;
  const signature = await createHmacSha256(patToken, `runtime-config:${payload}`);
  return `${payload}.${toBase64Url(signature)}`;
}

export async function verifyWorkflowRuntimeConfigToken(jobId: number, token: string, patToken: string): Promise<boolean> {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    return false;
  }

  const parsedJobId = Number.parseInt(parts[0] || "", 10);
  const expiresAt = Number.parseInt(parts[1] || "", 10);
  if (!Number.isFinite(parsedJobId) || !Number.isFinite(expiresAt) || parsedJobId !== jobId) {
    return false;
  }

  if (Date.now() > expiresAt) {
    return false;
  }

  const actualSignature = fromBase64Url(parts[2] || "");
  if (!actualSignature) {
    return false;
  }

  const expectedSignature = await createHmacSha256(patToken, `runtime-config:${parts[0]}.${parts[1]}`);
  return timingSafeEqual(actualSignature, expectedSignature);
}

export async function dispatchWorkflow(
  githubSettings: GithubSettings,
  workflowInputs: Record<string, string>,
  workflowName: string = WORKFLOW_NAME
): Promise<DispatchResult> {
  try {
    const workflowFile = workflowName || WORKFLOW_NAME;
    const dispatchStartedAt = Date.now();
    const jobId = String(workflowInputs.job_id || "");
    const automationId = String(workflowInputs.automation_id || "");
    const dispatchNonce = String(workflowInputs.dispatch_nonce || createDispatchNonce(Number(jobId) || 0, Number(automationId) || 0));
    const correlatedInputs = { ...workflowInputs, dispatch_nonce: dispatchNonce };
    const legacyInputs = { ...workflowInputs };
    delete legacyInputs.dispatch_nonce;
    let activeDispatchInputs: Record<string, string> = correlatedInputs;
    let dispatchNonceAccepted = true;
    console.log("[dispatchWorkflow] Workflow file:", workflowFile);
    console.log("[dispatchWorkflow] Dispatch nonce:", dispatchNonce);
    console.log("[dispatchWorkflow] Workflow inputs keys:", Object.keys(correlatedInputs));

    const getPayloadBytes = (inputs: Record<string, string>) =>
      new TextEncoder().encode(JSON.stringify({ ref: "master", inputs })).length;
    let payloadBytes = getPayloadBytes(activeDispatchInputs);
    console.log("[dispatchWorkflow] Payload bytes:", payloadBytes);

    let workflowDispatchTarget = workflowFile;
    let workflowResolveWarning: string | undefined;

    async function postDispatch(idOrFile: string, inputs: Record<string, string>): Promise<{ status: number; text: string }> {
      const encodedWorkflow = encodeURIComponent(idOrFile);
      const dispatchUrl = `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/workflows/${encodedWorkflow}/dispatches`;
      const requestBody = JSON.stringify({ ref: "master", inputs });
      console.log("[dispatchWorkflow] Dispatch URL:", dispatchUrl);
      console.log("[dispatchWorkflow] Dispatch input keys:", Object.keys(inputs));
      const response = await fetchGithubWithTimeout(dispatchUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubSettings.pat_token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "AutomationSystem/1.0",
        },
        body: requestBody,
      });
      const status = response.status;
      const text = await response.text();
      console.log("[dispatchWorkflow] Response status:", status, "body:", text.substring(0, 500));
      return { status, text };
    }

    let dispatchResponse = await postDispatch(workflowDispatchTarget, activeDispatchInputs);
    let status = dispatchResponse.status;
    let responseText = dispatchResponse.text;

    if (
      status !== 204 &&
      status !== 201 &&
      status !== 200 &&
      (status === 404 || status === 422) &&
      /workflow_dispatch|not found|does not exist/i.test(responseText)
    ) {
      const resolved = await resolveWorkflowDispatchTarget(githubSettings, workflowFile);
      workflowResolveWarning = resolved.warning;
      if (resolved.idOrFile !== workflowDispatchTarget) {
        workflowDispatchTarget = resolved.idOrFile;
        console.log("[dispatchWorkflow] Retrying dispatch with resolved workflow target:", workflowDispatchTarget);
        dispatchResponse = await postDispatch(workflowDispatchTarget, activeDispatchInputs);
        status = dispatchResponse.status;
        responseText = dispatchResponse.text;
      }
    }

    if (
      status === 422 &&
      /unexpected inputs provided/i.test(responseText) &&
      /dispatch_nonce/i.test(responseText)
    ) {
      // Backward compatibility: a Worker deploy can go live before the GitHub
      // workflow file on the default branch has the new dispatch_nonce input.
      // Older workflow_dispatch definitions reject unknown inputs. Retry without
      // dispatch_nonce so jobs still reach GitHub Actions. Run lookup then uses
      // the explicit job-id/title fallback and otherwise stays pending instead
      // of attaching the wrong latest run.
      console.warn("[dispatchWorkflow] Workflow does not accept dispatch_nonce; retrying with legacy inputs");
      activeDispatchInputs = legacyInputs;
      dispatchNonceAccepted = false;
      payloadBytes = getPayloadBytes(activeDispatchInputs);
      dispatchResponse = await postDispatch(workflowDispatchTarget, activeDispatchInputs);
      status = dispatchResponse.status;
      responseText = dispatchResponse.text;
    }

    if (status !== 204 && status !== 201 && status !== 200) {
      console.log("[dispatchWorkflow] Error response:", responseText);
      if (status === 422 && responseText.includes("inputs are too large")) {
        return {
          success: false,
          runId: null,
          runUrl: null,
          error: `GitHub workflow dispatch payload is too large (${payloadBytes} bytes).`,
          payloadBytes,
          dispatchStatus: status,
          dispatchNonce,
        };
      }
      const workflowHint = workflowResolveWarning
        ? ` ${workflowResolveWarning}.`
        : ` Confirm .github/workflows/${workflowFile} exists on master/main and contains workflow_dispatch.`;
      return {
        success: false,
        runId: null,
        runUrl: null,
        error: `GitHub API error while dispatching ${workflowFile}: ${status} - ${responseText}.${workflowHint}`,
        payloadBytes,
        dispatchStatus: status,
        dispatchNonce,
      };
    }
    console.log("[dispatchWorkflow] Workflow dispatched, checking for run ID...");

    let runId: number | null = null;
    let runUrl: string | null = null;
    let runLookupWarning = "";

    for (const waitMs of [2000, 5000, 9000]) {
      await sleep(waitMs);
      try {
        const runsRes = await fetchGithubWithTimeout(
          `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/workflows/${workflowDispatchTarget}/runs?event=workflow_dispatch&branch=master&per_page=5`,
          {
            headers: {
              Authorization: `Bearer ${githubSettings.pat_token}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "AutomationSystem/1.0",
            },
          },
          12000
        );

        if (!runsRes.ok) {
          const body = await runsRes.text();
          runLookupWarning = `Workflow dispatched but run lookup failed: GitHub API ${runsRes.status} - ${body.substring(0, 300)}`;
          console.error("[dispatchWorkflow] Failed to get workflow runs:", runsRes.status, body);
        } else {
          const runsData = await runsRes.json() as { workflow_runs?: Array<{ id: number; html_url: string; event?: string; display_title?: string; name?: string; created_at?: string }> };
          const runs = runsData.workflow_runs || [];
          const run = runs.find((item) => isMatchingWorkflowRun(item, dispatchNonce, jobId, dispatchStartedAt));
          if (run) {
            runId = run.id;
            runUrl = run.html_url;
            console.log("[dispatchWorkflow] Got correlated run ID:", runId, "title:", run.display_title || run.name || "");
            break;
          }
          const titles = runs.map((item) => `${item.id}:${item.display_title || item.name || "untitled"}`).slice(0, 5).join(", ");
          runLookupWarning = dispatchNonceAccepted
            ? `Workflow dispatched but no correlated run was visible yet for nonce ${dispatchNonce}. Recent runs: ${titles || "none"}`
            : `Workflow dispatched with legacy inputs because the default-branch workflow does not accept dispatch_nonce. No safe correlated run was visible yet for job ${jobId}. Recent runs: ${titles || "none"}`;
          console.log("[dispatchWorkflow] No workflow runs found yet");
        }
      } catch (e) {
        runLookupWarning = `Workflow dispatched but run lookup errored: ${e instanceof Error ? e.message : String(e)}`;
        console.error("[dispatchWorkflow] Error getting workflow runs:", e);
      }
    }

    if (!runId) {
      const fallbackUrl = getWorkflowRunsUrl(githubSettings, workflowFile);
      console.error("[dispatchWorkflow] Dispatch returned success but no run ID found. Keeping job running with pending lookup.");
      return {
        success: true,
        runId: null,
        runUrl: fallbackUrl,
        warning: runLookupWarning || "Workflow dispatched but run ID was not visible yet.",
        dispatched: true,
        pendingRunLookup: true,
        payloadBytes,
        dispatchStatus: status,
        dispatchNonce,
      };
    }

    return {
      success: true,
      runId,
      runUrl,
      dispatched: true,
      payloadBytes,
      dispatchStatus: status,
      dispatchNonce,
      warning: dispatchNonceAccepted ? undefined : "Workflow accepted legacy inputs only. Update .github/workflows/video-automation.yml and image-automation.yml on the default branch to enable exact dispatch_nonce correlation.",
    };
  } catch (err) {
    console.error("[dispatchWorkflow] Error:", err instanceof Error ? err.message : String(err));
    return {
      success: false,
      runId: null,
      runUrl: null,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

export async function getWorkflowRunStatus(
  githubSettings: GithubSettings,
  runId: number
): Promise<{ status: string; conclusion: string | null; html_url: string } | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${runId}`,
      { headers: githubHeaders(githubSettings.pat_token) }
    );

    if (!response.ok) return null;

    const data = await response.json() as { status: string; conclusion: string | null; html_url: string };
    return { status: data.status, conclusion: data.conclusion, html_url: data.html_url };
  } catch (err) {
    console.error("[getWorkflowRunStatus] Error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function getWorkflowRunJobs(
  githubSettings: GithubSettings,
  runId: number
): Promise<Array<{ name: string; status: string; conclusion: string | null; number: number }>> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${githubSettings.repo_owner}/${githubSettings.repo_name}/actions/runs/${runId}/jobs`,
      { headers: githubHeaders(githubSettings.pat_token) }
    );

    if (!response.ok) return [];

    const data = await response.json() as {
      jobs?: Array<{
        steps?: Array<{ name: string; status: string; conclusion: string | null; number: number }>;
      }>;
    };
    return data.jobs?.[0]?.steps || [];
  } catch (err) {
    console.error("[getWorkflowRunJobs] Error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export function buildWorkflowInputs(
  jobId: number,
  automationId: number
): WorkflowInputs {
  const inputs: WorkflowInputs = {
    job_id: String(jobId),
    automation_id: String(automationId),
    dispatch_nonce: createDispatchNonce(jobId, automationId),
    worker_webhook_url: WORKER_WEBHOOK_URL,
  };

  return inputs;
}
