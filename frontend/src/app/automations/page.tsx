"use client";
import { useCallback, useEffect, useState } from "react";
import AutomationModal from "@/components/automations/AutomationModal";
import ImageAutomationModal from "@/components/automations/image/ImageAutomationModal";
import DubbingAutomationModal from "@/components/automations/dubbing/DubbingAutomationModal";
import ScheduledPostsModal from "@/components/ui/ScheduledPostsModal";
import { Automation } from "@/components/automations/types";
import { api, ApiError } from "@/lib/api";

interface StepInfo { name: string; status: string; conclusion: string | null }
interface GithubLogAnalysis { summary?: string | null; detected?: string[]; has_cookie_or_signin_signal?: boolean; snippets?: string[] }
interface GithubLogPreview { ok?: boolean; github_job_id?: number; github_job_name?: string; error?: string; analysis?: GithubLogAnalysis }
interface JobArtifact { name: string; archive_download_url?: string; size_in_bytes?: number }
interface RunningJob { jobId: number; status: string; githubRunUrl: string | null; steps: StepInfo[]; error: string | null; progress: number; githubLog?: GithubLogPreview | null; artifacts?: JobArtifact[]; diagnostics?: { summary?: string | null; cookie_or_signin_possible?: boolean } | null }
interface AutomationPostStats { scheduled: number; posted: number }
interface LinkQueueStatus { totalLinks: number; processedLinks: number; currentIndex: number; remainingLinks: number; allCompleted: boolean }
interface AutomationStats { totalJobs: number; successJobs: number; failedJobs: number; runningJobs: number; queuedJobs: number; otherJobs: number }
interface ScheduledAccountDetail { id: string; platform: string; username: string; scheduled_at: string | null; postforme_id: string | null }
interface ScheduledPostDetails { title: string; description: string; hashtags: string[]; caption: string; top_tagline: string; bottom_tagline: string; schedule_mode: string; scheduled_accounts: ScheduledAccountDetail[] }
interface ScheduledUpload { id: number; job_id: number; automation_id?: number | null; automation_name?: string | null; media_url: string; post_status: string; scheduled_at: string | null; postforme_id: string | null; post_details?: ScheduledPostDetails | null; scheduled_account_count?: number }
interface AutomationScheduledSummary { uploads: ScheduledUpload[]; posts: number; accounts: number }
interface DashboardActiveJob { jobId: number; status: string; githubRunId: number | null; githubRunUrl: string | null; error: string | null }
interface DashboardSummaryEntry {
  job_stats?: AutomationStats;
  post_stats?: AutomationPostStats;
  scheduled_summary?: { posts: number; accounts: number };
  latest_active_job?: DashboardActiveJob | null;
  latest_failed_error?: string | null;
  link_queue?: LinkQueueStatus;
}

const EMPTY_SCHEDULED_UPLOADS: ScheduledUpload[] = [];

function parseAutomationDate(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function parseAutomationConfig(config: string | null): Record<string, unknown> {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function isDubbingAutomationConfig(config: Record<string, unknown>): boolean {
  const dubbing = config.dubbing;
  return config.workflow === "dubbing" || (Boolean(dubbing) && typeof dubbing === "object");
}

type DubbingDoctorVerdict = "ready" | "degraded" | "blocked";
interface DubbingDoctorReport {
  ok: boolean;
  verdict: DubbingDoctorVerdict;
  missing: string[];
  has_ffmpeg?: boolean;
  has_yt_dlp?: boolean;
  has_transcribe?: boolean;
  has_translate?: boolean;
  has_voice?: boolean;
  ok_count?: number;
  total?: number;
  checked_at?: string;
  error?: string;
}

function estimateProgress(status: string): number {
  if (status === "success" || status === "failed") return 100;
  if (status === "running") return 60;
  if (status === "queued" || status === "pending") return 20;
  return 0;
}

function normalizeSteps(value: unknown): StepInfo[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      return {
        name: typeof record.name === "string" ? record.name : "Runner step",
        status: typeof record.status === "string" ? record.status : "unknown",
        conclusion: typeof record.conclusion === "string" ? record.conclusion : null,
      };
    })
    .filter((item): item is StepInfo => Boolean(item));
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const data = error.data as { error?: string } | undefined;
    return data?.error || error.message || fallback;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

function getApiErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof ApiError && error.data && typeof error.data === "object") {
    const maybeData = (error.data as { data?: unknown }).data;
    return maybeData && typeof maybeData === "object" ? maybeData as Record<string, unknown> : {};
  }
  return {};
}

function buildFailedRunState(existing: RunningJob | undefined, message: string, data: Record<string, unknown> = {}): RunningJob {
  const jobId = typeof data.job_id === "number" ? data.job_id : existing?.jobId || 0;
  return {
    jobId,
    status: "failed",
    githubRunUrl: existing?.githubRunUrl || null,
    steps: normalizeSteps(existing?.steps).length > 0 ? normalizeSteps(existing?.steps) : [
      { name: message, status: "completed", conclusion: "failure" },
    ],
    error: message,
    progress: 100,
    githubLog: null,
    artifacts: [],
    diagnostics: { summary: message, cookie_or_signin_possible: false },
  };
}

function buildRunningJobSummary(job: DashboardActiveJob): RunningJob {
  return {
    jobId: job.jobId,
    status: job.status === "pending" ? "queued" : job.status,
    githubRunUrl: job.githubRunUrl,
    steps: [],
    error: job.error,
    progress: estimateProgress(job.status),
    githubLog: null,
    artifacts: [],
    diagnostics: null,
  };
}

export default function AutomationsPage() {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState<"video" | "image" | "dubbing">("video");
  const [editData, setEditData] = useState<Automation | null>(null);
  const [runningJobs, setRunningJobs] = useState<Record<number, RunningJob>>({});
  const [automationStats, setAutomationStats] = useState<Record<number, AutomationPostStats>>({});
  const [showLogs, setShowLogs] = useState<{ autoId: number; job: RunningJob } | null>(null);
  const [showScheduledPosts, setShowScheduledPosts] = useState<{ automationId: number; automationName: string } | null>(null);
  const [linkQueues, setLinkQueues] = useState<Record<number, LinkQueueStatus>>({});
  const [failedErrors, setFailedErrors] = useState<Record<number, string | null>>({});
  const [now, setNow] = useState(() => Date.now());
  const [jobStats, setJobStats] = useState<Record<number, AutomationStats>>({});
  const [scheduledUploadsByAutomation, setScheduledUploadsByAutomation] = useState<Record<number, AutomationScheduledSummary>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [logsRefreshing, setLogsRefreshing] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dubbingDoctor, setDubbingDoctor] = useState<DubbingDoctorReport | null>(null);
  const [dubbingDoctorLoading, setDubbingDoctorLoading] = useState(false);

  const loadData = useCallback(async (options?: { showRefreshing?: boolean; syncScheduled?: boolean }) => {
    const showRefreshing = options?.showRefreshing ?? false;
    if (showRefreshing) {
      setRefreshing(true);
    }

    try {
      const params = new URLSearchParams();
      if (options?.syncScheduled) {
        params.set("sync_scheduled", "1");
      }

      const response = await api.get<{ automations: Automation[]; summaries: Record<string, DashboardSummaryEntry> }>(
        `/api/automations/dashboard${params.toString() ? `?${params.toString()}` : ""}`
      );
      const data = (response.success ? response.data : {}) as { automations?: Automation[]; summaries?: Record<string, DashboardSummaryEntry> };
      const nextAutomations: Automation[] = Array.isArray(data.automations) ? data.automations : [];
      const summaries = (data.summaries || {}) as Record<string, DashboardSummaryEntry>;

      setLoadError(null);
      setAutomations(nextAutomations);

      const nextLinkQueues: Record<number, LinkQueueStatus> = {};
      const nextFailedErrors: Record<number, string | null> = {};
      const nextJobStats: Record<number, AutomationStats> = {};
      const nextAutomationStats: Record<number, AutomationPostStats> = {};
      const nextScheduledUploads: Record<number, AutomationScheduledSummary> = {};
      const nextRunningJobs: Record<number, RunningJob> = {};

      for (const automation of nextAutomations) {
        const summary = summaries[String(automation.id)] || {};
        nextFailedErrors[automation.id] = summary.latest_failed_error || null;
        nextLinkQueues[automation.id] = summary.link_queue || {
          totalLinks: 0,
          processedLinks: 0,
          currentIndex: 0,
          remainingLinks: 0,
          allCompleted: false,
        };
        nextJobStats[automation.id] = summary.job_stats || {
          totalJobs: 0,
          successJobs: 0,
          failedJobs: 0,
          runningJobs: 0,
          queuedJobs: 0,
          otherJobs: 0,
        };
        nextAutomationStats[automation.id] = summary.post_stats || { scheduled: 0, posted: 0 };
        nextScheduledUploads[automation.id] = {
          uploads: [],
          posts: summary.scheduled_summary?.posts || 0,
          accounts: summary.scheduled_summary?.accounts || 0,
        };

        const latestJob = summary.latest_active_job;
        if (latestJob && (latestJob.status === "running" || latestJob.status === "queued" || latestJob.status === "pending")) {
          nextRunningJobs[automation.id] = buildRunningJobSummary(latestJob);
        }
      }

      setLinkQueues(nextLinkQueues);
      setFailedErrors(nextFailedErrors);
      setJobStats(nextJobStats);
      setAutomationStats(nextAutomationStats);
      setScheduledUploadsByAutomation(nextScheduledUploads);
      setRunningJobs(nextRunningJobs);
    } catch (error) {
      console.error("Failed to load automations:", error);
      setLoadError(error instanceof Error ? error.message : "Failed to load automations");
    } finally {
      setLoading(false);
      if (showRefreshing) {
        setRefreshing(false);
      }
    }
  }, []);

  const fetchJobLogs = useCallback(async (job: RunningJob): Promise<RunningJob> => {
    try {
      const response = await api.get<{
        run_status: string;
        run_conclusion: string;
        run_url: string;
        steps: StepInfo[];
        error?: string | null;
        github_log?: GithubLogPreview | null;
        artifacts?: JobArtifact[];
        diagnostics?: { summary?: string | null; cookie_or_signin_possible?: boolean } | null;
      }>(`/api/jobs/${job.jobId}/logs?include_log_text=1&t=${Date.now()}`);
      if (!response.success || !response.data) {
        return job;
      }
      const payload = response.data;

      const steps: StepInfo[] = normalizeSteps(payload.steps);
      const done = steps.filter((step) => step.conclusion === "success").length;
      const total = steps.length || 1;
      let status = payload.run_status || job.status;
      if (status === "completed") {
        status = payload.run_conclusion === "success" ? "success" : "failed";
      }
      const logSummary = payload.diagnostics?.summary || payload.github_log?.analysis?.summary || null;
      const logSnippets = Array.isArray(payload.github_log?.analysis?.snippets) ? payload.github_log?.analysis?.snippets || [] : [];

      return {
        ...job,
        status,
        githubRunUrl: payload.run_url || job.githubRunUrl,
        steps,
        error: payload.error || (status === "failed" ? logSummary || logSnippets[0] || job.error : job.error),
        progress: Math.max(estimateProgress(status), Math.round((done / total) * 100)),
        githubLog: payload.github_log || job.githubLog || null,
        artifacts: Array.isArray(payload.artifacts) ? payload.artifacts : (job.artifacts || []),
        diagnostics: payload.diagnostics || job.diagnostics || null,
      };
    } catch {
      return job;
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === "visible";
      setPageVisible(isVisible);
      if (isVisible) {
        void loadData();
      }
    };

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [loadData]);

  useEffect(() => {
    if (!pageVisible) {
      return;
    }

    const hasActiveJobs = Object.keys(runningJobs).length > 0;
    const refreshDelay = hasActiveJobs ? 15000 : 60000;
    const timeout = window.setTimeout(() => {
      void loadData();
    }, refreshDelay);

    return () => window.clearTimeout(timeout);
  }, [loadData, pageVisible, runningJobs]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  // Live dubbing-engine dependency check against local-runner /api/dubbing/doctor
  const refreshDubbingDoctor = useCallback(async (force = false) => {
    setDubbingDoctorLoading(true);
    try {
      const url = `http://127.0.0.1:3000/api/dubbing/doctor${force ? "?refresh=1" : ""}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload = await response.json();
      if (payload && payload.success && payload.data) {
        setDubbingDoctor(payload.data as DubbingDoctorReport);
      } else {
        setDubbingDoctor({
          ok: false,
          verdict: "blocked",
          missing: ["Local runner did not return doctor data"],
          error: payload?.error || "Unknown response",
        });
      }
    } catch (err) {
      setDubbingDoctor({
        ok: false,
        verdict: "blocked",
        missing: ["Local runner is not reachable"],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDubbingDoctorLoading(false);
    }
  }, []);

  useEffect(() => {
    const hasDubbing = automations.some((auto) =>
      isDubbingAutomationConfig(parseAutomationConfig(auto.config))
    );
    if (!hasDubbing) return;
    void refreshDubbingDoctor(false);
    const interval = window.setInterval(() => { void refreshDubbingDoctor(false); }, 60_000);
    return () => window.clearInterval(interval);
  }, [automations, refreshDubbingDoctor]);

  useEffect(() => {
    if (!showLogs) {
      return;
    }

    let cancelled = false;

    const refreshLogs = async () => {
      setLogsRefreshing(true);
      const nextJob = await fetchJobLogs(showLogs.job);
      if (cancelled) {
        return;
      }

      setLogsRefreshing(false);
      setShowLogs((current) => current ? { ...current, job: nextJob } : current);
      setRunningJobs((current) => {
        if (!current[showLogs.autoId] || current[showLogs.autoId].jobId !== nextJob.jobId) {
          return current;
        }
        if (nextJob.status === "success" || nextJob.status === "failed") {
          const next = { ...current };
          delete next[showLogs.autoId];
          return next;
        }
        return {
          ...current,
          [showLogs.autoId]: nextJob,
        };
      });
    };

    void refreshLogs();

    if (showLogs.job.status !== "running" && showLogs.job.status !== "queued" && showLogs.job.status !== "pending") {
      return () => {
        cancelled = true;
      };
    }

    const interval = window.setInterval(() => {
      void refreshLogs();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fetchJobLogs, showLogs?.autoId, showLogs?.job.jobId, showLogs?.job.status]);

  const handleRun = async (autoId: number) => {
    setRunningJobs((current) => ({
      ...current,
      [autoId]: {
        jobId: 0,
        status: "queued",
        githubRunUrl: null,
        steps: [],
        error: null,
        progress: 20,
        githubLog: null,
        artifacts: [],
        diagnostics: null,
      },
    }));

    try {
      const response = await api.post<{ job_id?: number | null; github_run_id?: number | null; execution_mode?: string | null; in_progress?: boolean }>(`/api/automations/${autoId}/run`, {});
      if (response.success) {
        if (response.data?.job_id) {
          setRunningJobs((current) => ({
            ...current,
            [autoId]: {
              ...(current[autoId] || { status: "queued", githubRunUrl: null, steps: [], error: null, progress: 20 }),
              jobId: Number(response.data?.job_id) || current[autoId]?.jobId || 0,
              steps: normalizeSteps(current[autoId]?.steps),
            },
          }));
        }
        window.setTimeout(() => {
          void loadData();
        }, 2500);
      } else {
        setRunningJobs((current) => ({
          ...current,
          [autoId]: buildFailedRunState(current[autoId], response.error || "Unknown error", response.data || {}),
        }));
      }
    } catch (error) {
      const message = getApiErrorMessage(error, "Request failed");
      const errorData = getApiErrorData(error);
      setRunningJobs((current) => ({
        ...current,
        [autoId]: buildFailedRunState(current[autoId], message, errorData),
      }));
    }
  };

  const handleAction = async (id: number, action: string) => {
    if (action === "run") {
      void handleRun(id);
      return;
    }

    try {
      if (action === "delete" && !window.confirm("Delete this automation and its jobs?")) {
        return;
      }

      let response;
      if (action === "delete") {
        response = await api.delete<{ success: boolean; error?: string }>(`/api/automations/${id}`);
      } else {
        response = await api.post<{ success: boolean; error?: string }>(`/api/automations/${id}/${action}`, {});
      }

      if (!response.success) {
        window.alert(response.error || `${action} failed`);
        return;
      }

      void loadData({ syncScheduled: true });
    } catch {
      window.alert(`${action} failed`);
    }
  };

  const openCreate = (type: "video" | "image" | "dubbing") => { setEditData(null); setModalType(type); setShowModal(true); };
  const openEdit = (auto: Automation) => {
    const config = parseAutomationConfig(auto.config);
    if (isDubbingAutomationConfig(config)) {
      setEditData(auto);
      setModalType("dubbing");
      setShowModal(true);
    } else {
      setEditData(auto);
      setModalType(auto.type as "video" | "image");
      setShowModal(true);
    }
  };

  const sc = (status: string) => status === "success" ? "#10b981" : status === "failed" ? "#ef4444" : status === "running" || status === "in_progress" ? "#6366f1" : "#f59e0b";
  const si = (step: StepInfo) => step.conclusion === "success" ? "\u2713" : step.conclusion === "failure" ? "\u2717" : step.status === "in_progress" ? "\u27F3" : "\u25CB";
  const filtered = filter === "all" ? automations : automations.filter((automation) => {
    const config = parseAutomationConfig(automation.config);
    const isDubbing = isDubbingAutomationConfig(config);
    if (filter === "dubbing") return isDubbing;
    if (filter === "video") return automation.type === "video" && !isDubbing;
    return automation.type === filter;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div><h2 className="text-3xl font-bold">Automations</h2><p className="text-[#a1a1aa] mt-1">Manage your automation pipelines</p></div>
        <div className="flex gap-3">
          <button
            onClick={() => void loadData({ showRefreshing: true, syncScheduled: true })}
            disabled={refreshing}
            className="glass-button text-sm py-2 px-4 flex items-center gap-2"
          >
            <svg className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24">
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button onClick={() => openCreate("video")} className="glass-button-primary">+ Video</button>
          <button onClick={() => openCreate("image")} className="glass-button-primary">+ Image</button>
          <button onClick={() => openCreate("dubbing")} className="glass-button-primary">+ Dubbing</button>
        </div>
      </div>

      <div className="flex gap-2 mb-6">
        {["all", "video", "image", "dubbing"].map((item) => (
          <button key={item} onClick={() => setFilter(item)} className={`px-4 py-2 rounded-xl text-sm font-medium capitalize ${filter === item ? "bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] text-white" : "glass-button"}`}>
            {item === "all" ? "All" : item}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="glass-card p-6 mb-6 border border-red-500/30 bg-red-500/10">
          <p className="text-red-400 font-medium">Failed to load automations</p>
          <p className="text-sm text-red-300/70 mt-1">{loadError}</p>
          <button onClick={() => { setLoadError(null); void loadData(); }} className="mt-3 glass-button text-sm py-1.5 px-3 text-red-400">Retry</button>
        </div>
      )}

      {loading ? <div className="text-center py-16 text-[#a1a1aa]">Loading...</div> : filtered.length === 0 ? (
        <div className="glass-card p-12 text-center"><p className="text-lg font-medium">No automations yet</p><p className="text-[#a1a1aa] mt-1">Create your first automation</p></div>
      ) : (
        <div className="grid gap-4">
          {filtered.map((auto) => {
            const runningJob = runningJobs[auto.id];
            const stats = automationStats[auto.id] || { scheduled: 0, posted: 0 };
            const scheduledSummary = scheduledUploadsByAutomation[auto.id] || { uploads: [], posts: 0, accounts: 0 };
            const linkQueue = linkQueues[auto.id];
            const jobs = jobStats[auto.id] || { totalJobs: 0, successJobs: 0, failedJobs: 0, runningJobs: 0, queuedJobs: 0, otherJobs: 0 };
            const config = parseAutomationConfig(auto.config);
            const isDubbing = isDubbingAutomationConfig(config);
            const isLocalFolderSource = config.video_source === "local_folder";
            const nextRunTs = parseAutomationDate(auto.next_run);
            const countdownLabel = nextRunTs ? (nextRunTs <= now ? "Running soon" : `Next in ${formatCountdown(nextRunTs - now)}`) : null;
            const nextRunTitle = nextRunTs ? `Next run ${new Date(nextRunTs).toLocaleString()}` : undefined;
            const isRunning = Boolean(runningJob) || jobs.runningJobs > 0 || jobs.queuedJobs > 0;
            const totalFetched = linkQueue ? linkQueue.totalLinks : jobs.totalJobs;

            return (
              <div key={auto.id} className="glass-card overflow-hidden">
                <div className="p-5 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl ${
                      isDubbing
                        ? "bg-[rgba(20,184,166,0.15)] text-[#5eead4]"
                        : auto.type === "video"
                          ? "bg-[rgba(139,92,246,0.15)] text-[#8b5cf6]"
                          : "bg-[rgba(236,72,153,0.15)] text-[#ec4899]"
                    }`}>{isDubbing ? "\u266B" : auto.type === "video" ? "\u25B6" : "\uD83D\uDDBC"}</div>
                    <div>
                      <h4 className="font-semibold text-lg">{auto.name}</h4>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className={`badge ${isDubbing ? "badge-dubbing" : auto.type === "video" ? "badge-video" : "badge-image"}`}>{isDubbing ? "dubbing" : auto.type}</span>
                        <span className={`badge badge-${auto.status}`}>{auto.status}</span>
                        {isRunning && (
                          <span className="text-[11px] px-2 py-1 rounded-lg bg-[rgba(99,102,241,0.15)] text-indigo-300">
                            Running ({jobs.runningJobs + jobs.queuedJobs})
                          </span>
                        )}
                        {countdownLabel && !runningJob && (
                          <span className="text-[11px] px-2 py-1 rounded-lg bg-[rgba(6,182,212,0.14)] text-cyan-300" title={nextRunTitle}>
                            {countdownLabel}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEdit(auto)} className="glass-button text-sm py-2 px-4">Edit</button>
                    {runningJob ? (
                      <>
                        <button onClick={() => setShowLogs({ autoId: auto.id, job: runningJob })} className="glass-button-primary text-sm py-2 px-4 flex items-center gap-2">
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                          {runningJob.status === "running" ? "Live Logs" : "Queued"}
                        </button>
                        {runningJob.jobId > 0 && (
                          <button
                            onClick={async () => {
                              if (!confirm("Cancel this running job?")) return;
                              try {
                                const response = await api.post<{ success: boolean; error?: string }>(`/api/jobs/${runningJob.jobId}/cancel`, {});
                                if (response.success) {
                                  alert("Job cancelled!");
                                  void loadData();
                                } else {
                                  alert(`Failed: ${response.error}`);
                                }
                              } catch {
                                alert("Cancel failed!");
                              }
                            }}
                            className="glass-button text-sm py-2 px-4 text-[#f59e0b]"
                          >
                            Cancel
                          </button>
                        )}
                      </>
                    ) : auto.status === "active" && !isDubbing && <button onClick={() => void handleRun(auto.id)} className="glass-button-primary text-sm py-2 px-4">Run Now</button>}
                    {auto.status === "active" && !runningJob && !isDubbing && <button onClick={() => void handleAction(auto.id, "pause")} className="glass-button text-sm py-2 px-4">Pause</button>}
                    {auto.status !== "active" && !runningJob && !isDubbing && <button onClick={() => void handleAction(auto.id, "resume")} className="glass-button text-sm py-2 px-4">Resume</button>}
                    {isDubbing && !runningJob && (() => {
                      const doc = dubbingDoctor;
                      const verdict = doc?.verdict ?? (dubbingDoctorLoading ? "loading" : "blocked");
                      const tooltip = doc?.missing?.length
                        ? `Missing: ${doc.missing.join("; ")}`
                        : (doc?.error || "See DUBBING_SETUP.md for install steps");
                      let label = "Engine setup pending";
                      let badgeClass = "rounded-xl px-3 py-2 text-xs font-semibold cursor-help";
                      if (verdict === "loading") {
                        label = "Checking engines…";
                        badgeClass += " bg-[rgba(99,102,241,0.12)] text-indigo-200";
                      } else if (verdict === "ready") {
                        label = `Engine ready (${doc?.ok_count ?? 0}/${doc?.total ?? 0})`;
                        badgeClass += " bg-[rgba(34,197,94,0.15)] text-emerald-200";
                      } else if (verdict === "degraded") {
                        label = "Engine partial — will fall back";
                        badgeClass += " bg-[rgba(234,179,8,0.18)] text-yellow-200";
                      } else {
                        label = "Engine setup needed";
                        badgeClass += " bg-[rgba(239,68,68,0.15)] text-red-200";
                      }
                      const canRun = auto.status === "active";
                      return (
                        <>
                          <span className={badgeClass} title={tooltip}>{label}</span>
                          {canRun && (
                            <button
                              onClick={() => void handleRun(auto.id)}
                              className="glass-button-primary text-sm py-2 px-4"
                              title={verdict === "degraded" ? "Engine partial — output may use placeholders" : "Run dubbing pipeline"}
                            >
                              Run Now
                            </button>
                          )}
                          {auto.status === "active" && (
                            <button onClick={() => void handleAction(auto.id, "pause")} className="glass-button text-sm py-2 px-4">Pause</button>
                          )}
                          {auto.status !== "active" && (
                            <button onClick={() => void handleAction(auto.id, "resume")} className="glass-button text-sm py-2 px-4">Resume</button>
                          )}
                          <button
                            onClick={() => void refreshDubbingDoctor(true)}
                            className="glass-button text-xs py-2 px-3"
                            title="Re-check engine availability"
                            disabled={dubbingDoctorLoading}
                          >
                            {dubbingDoctorLoading ? "…" : "Recheck"}
                          </button>
                        </>
                      );
                    })()}
                    <button onClick={() => void handleAction(auto.id, "delete")} className="glass-button text-sm py-2 px-4 text-[#ef4444]">Delete</button>
                  </div>
                </div>

                <div className="px-5 pb-5">
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 rounded-xl bg-[rgba(99,102,241,0.1)] border border-[rgba(99,102,241,0.2)]">
                      <div className="text-[10px] text-[#a1a1aa] uppercase tracking-wider mb-1">Total / Remaining</div>
                      {isLocalFolderSource ? (
                        <>
                          <div className="text-lg font-semibold text-[#818cf8]">Runner scan</div>
                          <div className="text-[10px] text-[#6b7280] mt-1">Local folder files are counted on the runner PC at run time</div>
                        </>
                      ) : (
                        <>
                          <div className="flex items-baseline gap-1">
                            <span className="text-xl font-bold text-[#818cf8]">
                              {linkQueue ? linkQueue.remainingLinks : (jobs.runningJobs + jobs.queuedJobs)}
                            </span>
                            <span className="text-xs text-[#a1a1aa]">/</span>
                            <span className="text-lg font-semibold text-[#6366f1]">
                              {linkQueue ? linkQueue.totalLinks : totalFetched}
                            </span>
                          </div>
                          <div className="text-[10px] text-[#6b7280] mt-1">
                            {linkQueue ? `${linkQueue.totalLinks} total links` : `jobs: ${jobs.totalJobs}`}
                          </div>
                        </>
                      )}
                    </div>

                    <div className="p-3 rounded-xl bg-[rgba(245,158,11,0.1)] border border-[rgba(245,158,11,0.2)]">
                      <div className="text-[10px] text-[#a1a1aa] uppercase tracking-wider mb-1">Processing</div>
                      <div className="flex items-baseline gap-1">
                        <span className={`text-xl font-bold ${isRunning ? "text-[#f59e0b]" : "text-[#6b7280]"}`}>
                          {jobs.runningJobs + jobs.queuedJobs}
                        </span>
                        <span className="text-xs text-[#a1a1aa]">jobs</span>
                      </div>
                      <div className="text-[10px] text-[#6b7280] mt-1">
                        {scheduledSummary.posts || stats.scheduled} scheduled
                      </div>
                    </div>

                    <div className="p-3 rounded-xl bg-[rgba(16,185,129,0.1)] border border-[rgba(16,185,129,0.2)]">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-[#a1a1aa] uppercase tracking-wider">Total Processed</div>
                        <button
                          onClick={async () => {
                            if (!confirm(`Reset rotation for "${auto.name}"? This will clear all processed videos.`)) return;
                            try {
                              const response = await api.delete<{ message: string }>(`/api/automations/${auto.id}/processed-videos`);
                              if (response.success) {
                                alert(`Reset! ${response.message || "Rotation cleared"}`);
                                void loadData();
                              } else {
                                alert(`Failed: ${response.error || "Reset failed"}`);
                              }
                            } catch (error) {
                              alert(error instanceof Error ? error.message : "Reset failed!");
                            }
                          }}
                          className="text-[10px] px-2 py-0.5 rounded bg-[rgba(239,68,68,0.2)] text-[#ef4444] hover:bg-[rgba(239,68,68,0.3)] transition-colors"
                          title="Reset rotation"
                        >
                          Reset
                        </button>
                      </div>
                      <div className="flex items-baseline gap-1 mt-1">
                        <span className="text-xl font-bold text-[#10b981]">{jobs.successJobs}</span>
                        {jobs.failedJobs > 0 && (
                          <span className="text-sm font-medium text-[#ef4444]">({jobs.failedJobs} failed)</span>
                        )}
                      </div>
                      <div className="text-[10px] text-[#6b7280] mt-1">
                        {stats.posted} posted
                      </div>
                      {jobs.failedJobs > 0 && failedErrors[auto.id] && (
                        <div className="mt-2 p-2 rounded-lg bg-[rgba(239,68,68,0.1)]">
                          <p className="text-[10px] text-[#ef4444] leading-relaxed break-words">
                            {(failedErrors[auto.id] || '').length > 120
                              ? (failedErrors[auto.id] || '').slice(0, 120) + '...'
                              : failedErrors[auto.id]}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {runningJob && (
                  <div className="px-5 pb-5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-[#a1a1aa]">Live status</span>
                      <span className="text-xs font-bold uppercase" style={{ color: sc(runningJob.status) }}>{runningJob.status}</span>
                    </div>
                    <div className="h-2 rounded-full bg-[rgba(255,255,255,0.1)] overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${runningJob.progress}%`, backgroundColor: sc(runningJob.status) }} />
                    </div>
                    <p className="text-[11px] text-[#6b7280] mt-3">
                      Step-by-step logs load only when you open the log modal. This keeps idle request volume low.
                    </p>
                    <button onClick={() => setShowLogs({ autoId: auto.id, job: runningJob })} className="text-xs text-[#6366f1] hover:underline mt-2">Open Logs</button>
                  </div>
                )}

                <div className="px-5 pb-5">
                  <button
                    onClick={() => setShowScheduledPosts({ automationId: auto.id, automationName: auto.name })}
                    className="w-full rounded-2xl border border-[rgba(245,158,11,0.18)] bg-[rgba(245,158,11,0.08)] px-4 py-4 text-left transition-colors hover:bg-[rgba(245,158,11,0.12)]"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.22em] text-[#fcd34d]">Scheduled</div>
                        <p className="text-sm font-semibold text-white mt-1">Scheduled posts for this automation</p>
                        <p className="text-xs text-[#d4d4d8] mt-1">
                          {scheduledSummary.posts > 0
                            ? `${scheduledSummary.posts} posts scheduled${scheduledSummary.accounts !== scheduledSummary.posts ? ` across ${scheduledSummary.accounts} accounts` : ""}`
                            : "No scheduled posts right now"}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="px-3 py-1.5 rounded-full bg-[rgba(245,158,11,0.18)] text-sm font-semibold text-[#fde68a]">
                          {scheduledSummary.posts}
                        </span>
                        <svg className="w-5 h-5 text-[#fcd34d]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showScheduledPosts && (
        <ScheduledPostsModal
          isOpen={Boolean(showScheduledPosts)}
          onClose={() => {
            setShowScheduledPosts(null);
            void loadData({ syncScheduled: true });
          }}
          automationId={showScheduledPosts.automationId}
          title={`${showScheduledPosts.automationName} Scheduled Posts`}
          initialUploads={scheduledUploadsByAutomation[showScheduledPosts.automationId]?.uploads || EMPTY_SCHEDULED_UPLOADS}
        />
      )}

      {showLogs && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowLogs(null)}>
          <div className="glass-card max-w-lg w-full max-h-[80vh] flex flex-col" onClick={(event) => event.stopPropagation()}>
            <div className="p-5 border-b border-[rgba(255,255,255,0.08)] flex justify-between">
              <div>
                <h3 className="text-lg font-bold">Runner Logs</h3>
                <p className="text-xs text-[#a1a1aa]">Job #{showLogs.job.jobId}</p>
              </div>
              <button onClick={() => setShowLogs(null)} className="glass-button py-1 px-3 text-sm">Close</button>
            </div>
            <div className="p-5 overflow-y-auto flex-1 scrollbar-thin space-y-4">
              <div className="flex items-center justify-between gap-3">
                <span className="badge" style={{ backgroundColor: `${sc(showLogs.job.status)}20`, color: sc(showLogs.job.status) }}>{showLogs.job.status}</span>
                {logsRefreshing && <span className="text-xs text-[#a1a1aa]">Refreshing...</span>}
              </div>
              <div className="h-3 rounded-full bg-[rgba(255,255,255,0.1)] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${showLogs.job.progress}%`, backgroundColor: sc(showLogs.job.status) }} />
              </div>
              {normalizeSteps(showLogs.job.steps).length > 0 ? (
                <div className="space-y-2">{normalizeSteps(showLogs.job.steps).map((step, index) => (
                  <div key={index} className="flex items-center gap-3 p-2 rounded-lg bg-[rgba(255,255,255,0.03)]">
                    <span style={{ color: sc(step.conclusion || step.status) }}>{si(step)}</span>
                    <span className="text-sm flex-1">{step.name}</span>
                    <span className="text-xs" style={{ color: sc(step.conclusion || step.status) }}>{step.conclusion === "success" ? "Done" : step.conclusion === "failure" ? "Failed" : "Running"}</span>
                  </div>
                ))}</div>
              ) : (
                <div className="p-3 rounded-lg bg-[rgba(255,255,255,0.03)] text-sm text-[#a1a1aa]">
                  Fetching the latest runner steps...
                </div>
              )}
              {showLogs.job.error && <div className="p-3 rounded-lg bg-[rgba(239,68,68,0.1)]"><p className="text-xs text-[#ef4444]">{showLogs.job.error}</p></div>}
              {showLogs.job.diagnostics?.summary && (
                <div className="p-3 rounded-lg bg-[rgba(99,102,241,0.1)] border border-[rgba(99,102,241,0.18)]">
                  <p className="text-xs font-semibold text-indigo-200">AI log diagnosis</p>
                  <p className="text-xs text-[#c4c4cc] mt-1">{showLogs.job.diagnostics.summary}</p>
                  {showLogs.job.diagnostics.cookie_or_signin_possible && (
                    <p className="text-xs text-[#f59e0b] mt-2">Cookie/sign-in signal detected. Update YouTube cookies or use a public source URL.</p>
                  )}
                </div>
              )}
              {Array.isArray(showLogs.job.githubLog?.analysis?.snippets) && (showLogs.job.githubLog?.analysis?.snippets?.length || 0) > 0 && (
                <div className="p-3 rounded-lg bg-[rgba(0,0,0,0.25)] border border-[rgba(255,255,255,0.08)]">
                  <p className="text-xs font-semibold text-[#f4f4f5] mb-2">GitHub error snippets</p>
                  <div className="space-y-2">
                    {(showLogs.job.githubLog?.analysis?.snippets || []).slice(0, 5).map((snippet, index) => (
                      <pre key={index} className="text-[11px] whitespace-pre-wrap break-words text-[#d4d4d8] bg-black/30 p-2 rounded">{snippet}</pre>
                    ))}
                  </div>
                </div>
              )}
              {showLogs.job.githubLog && showLogs.job.githubLog.ok === false && (
                <div className="p-3 rounded-lg bg-[rgba(245,158,11,0.1)] border border-[rgba(245,158,11,0.2)]">
                  <p className="text-xs text-[#f59e0b]">GitHub log fetch failed: {showLogs.job.githubLog.error || "Unknown error"}</p>
                </div>
              )}
              {Array.isArray(showLogs.job.artifacts) && showLogs.job.artifacts.length > 0 && (
                <div className="p-3 rounded-lg bg-[rgba(16,185,129,0.08)] border border-[rgba(16,185,129,0.18)]">
                  <p className="text-xs font-semibold text-emerald-200">Download Artifacts (available 3 days)</p>
                  <div className="space-y-1.5 mt-1">
                    {showLogs.job.artifacts.map((artifact, idx) => (
                      <div key={idx} className="flex items-center justify-between text-xs">
                        <span className="text-[#a1a1aa] truncate mr-2">{artifact.name}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {artifact.size_in_bytes > 0 && (
                            <span className="text-[#71717a]">{(artifact.size_in_bytes / 1024 / 1024).toFixed(1)} MB</span>
                          )}
                          {artifact.archive_download_url && (
                            <a href={artifact.archive_download_url} target="_blank" rel="noopener" className="text-emerald-300 hover:text-emerald-200 underline">
                              Download ZIP
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                {showLogs.job.githubRunUrl && <a href={showLogs.job.githubRunUrl} target="_blank" rel="noopener" className="glass-button-primary text-sm py-2 px-4">GitHub</a>}
                <button onClick={() => setShowLogs(null)} className="glass-button text-sm py-2 px-4">Close</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        modalType === "image" ? (
          <ImageAutomationModal
            editData={editData}
            onClose={() => setShowModal(false)}
            onSaved={() => {
              setShowModal(false);
              void loadData({ syncScheduled: true });
            }}
          />
        ) : modalType === "dubbing" ? (
          <DubbingAutomationModal
            editData={editData}
            onClose={() => setShowModal(false)}
            onSaved={() => {
              setShowModal(false);
              void loadData({ syncScheduled: true });
            }}
          />
        ) : (
          <AutomationModal
            type={modalType}
            editData={editData}
            onClose={() => setShowModal(false)}
            onSaved={() => {
              setShowModal(false);
              void loadData({ syncScheduled: true });
            }}
          />
        )
      )}
    </div>
  );
}
