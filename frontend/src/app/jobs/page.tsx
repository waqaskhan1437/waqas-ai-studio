"use client";
import { useState, useEffect } from "react";
import VideoPlayer from "@/components/ui/VideoPlayer";
import { getVideoUrl, getAllVideoUrls, getVideoUrls, getFetchStats, getLocalVideoPath, toLocalMediaUrl } from "@/lib/video-utils";

interface Job {
  id: number;
  automation_id: number;
  automation_name?: string | null;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  github_run_id: number | null;
  github_run_url: string | null;
  error_message: string | null;
  input_data: string | null;
  output_data: string | null;
  video_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface JobStats {
  total_jobs: number;
  success_jobs: number;
  failed_jobs: number;
  running_jobs: number;
  queued_jobs: number;
  cancelled_jobs: number;
  other_jobs: number;
  oldest_job_date: string | null;
  completed_before_7d: number;
  completed_before_30d: number;
  total_processed_videos: number;
  total_video_uploads: number;
}

type Tab = "jobs" | "management";

export default function JobsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("jobs");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<JobStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  const [showDeleteCompletedConfirm, setShowDeleteCompletedConfirm] = useState(false);
  const [deletingCompleted, setDeletingCompleted] = useState(false);
  const [showDeleteOldConfirm, setShowDeleteOldConfirm] = useState(false);
  const [deleteOldDate, setDeleteOldDate] = useState("");
  const [deletingOld, setDeletingOld] = useState(false);
  const [deleteJobId, setDeleteJobId] = useState<number | null>(null);

  useEffect(() => {
    fetchJobs();
  }, []);

  useEffect(() => {
    if (activeTab === "management") {
      fetchStats();
    }
  }, [activeTab]);

  const fetchJobs = async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      if (data.success) {
        setJobs(data.data || []);
      }
    } catch (err) {
      console.error("Failed to fetch jobs");
    }
    setLoading(false);
  };

  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const res = await fetch("/api/jobs/stats");
      const data = await res.json();
      if (data.success) {
        setStats(data.data);
      }
    } catch (err) {
      console.error("Failed to fetch stats");
    }
    setStatsLoading(false);
  };

  const handleRetry = async (id: number) => {
    try {
      await fetch(`/api/jobs/${id}/retry`, { method: "POST" });
      fetchJobs();
    } catch (err) {
      console.error("Retry failed");
    }
  };

  const handleDeleteAllJobs = async () => {
    try {
      await fetch("/api/jobs", { method: "DELETE" });
      fetchJobs();
      setShowDeleteAllConfirm(false);
      if (activeTab === "management") fetchStats();
    } catch (err) {
      console.error("Delete all jobs failed");
    }
  };

  const handleDeleteCompletedJobs = async () => {
    if (!stats) return;
    setDeletingCompleted(true);
    try {
      await fetch("/api/jobs/completed", { method: "DELETE" });
      fetchJobs();
      setShowDeleteCompletedConfirm(false);
      fetchStats();
    } catch (err) {
      console.error("Delete completed jobs failed");
    }
    setDeletingCompleted(false);
  };

  const handleDeleteOldJobs = async () => {
    if (!deleteOldDate) return;
    setDeletingOld(true);
    try {
      await fetch(`/api/jobs/old?before=${deleteOldDate}`, { method: "DELETE" });
      fetchJobs();
      setShowDeleteOldConfirm(false);
      fetchStats();
    } catch (err) {
      console.error("Delete old jobs failed");
    }
    setDeletingOld(false);
  };

  const handleDeleteJob = async (id: number) => {
    try {
      await fetch(`/api/jobs/${id}`, { method: "DELETE" });
      fetchJobs();
      setDeleteJobId(null);
    } catch (err) {
      console.error("Delete job failed");
    }
  };

  const handleForceContinue = async (id: number) => {
    try {
      const res = await fetch(`/api/jobs/${id}/force-continue`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        fetchJobs();
      } else {
        console.error("Force continue failed:", data.error);
      }
    } catch (err) {
      console.error("Force continue failed");
    }
  };

  const completedCount = stats
    ? stats.success_jobs + stats.failed_jobs + stats.cancelled_jobs
    : 0;

  const tabClass = (tab: Tab) =>
    `px-6 py-2.5 text-sm font-medium rounded-xl transition-colors ${
      activeTab === tab
        ? "bg-[#6366f1] text-white"
        : "text-[#a1a1aa] hover:text-white hover:bg-[rgba(255,255,255,0.05)]"
    }`;

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-3xl font-bold">Jobs</h2>
        <p className="text-[#a1a1aa] mt-1">Track automation execution history & manage database storage</p>
        <div className="flex gap-2 mt-4">
          <button onClick={() => setActiveTab("jobs")} className={tabClass("jobs")}>
            Jobs
          </button>
          <button onClick={() => setActiveTab("management")} className={tabClass("management")}>
            Data Management
          </button>
        </div>
      </div>

      {activeTab === "jobs" && (
        <>
          {loading ? (
            <div className="text-center py-16 text-[#a1a1aa]">Loading...</div>
          ) : jobs.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <svg className="w-16 h-16 mx-auto mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
              <p className="text-lg font-medium">No jobs yet</p>
              <p className="text-[#a1a1aa] mt-1">Run an automation to see jobs here</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {jobs.map((job) => {
                const videoUrl = getVideoUrl(job);
                const localVideoPath = getLocalVideoPath(job);
                const localVideoUrl = toLocalMediaUrl(localVideoPath);
                const allVideoUrls = getAllVideoUrls(job);
                const hasLocalPreview = Boolean(localVideoUrl || (videoUrl && /\/api\/local-media\?/i.test(videoUrl)));
                const previewUrls = localVideoUrl
                  ? [localVideoUrl, ...allVideoUrls.filter((url) => url !== localVideoUrl)]
                  : allVideoUrls;
                const fetchStats = getFetchStats(job);
                const videoUrls = getVideoUrls(job);
                return (
                  <div key={job.id} className="glass-card p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[rgba(99,102,241,0.15)]">
                          {videoUrl || localVideoUrl ? (
                            <svg className="w-5 h-5 text-[#6366f1]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.069A1 1 0 0121 8.88v6.24a1 1 0 01-1.447.894L15 14M3 8a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
                            </svg>
                          ) : (
                            <svg className="w-5 h-5 text-[#6366f1]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <p className="font-medium">Job #{job.id}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span className={`badge badge-${job.status}`}>{job.status}</span>
                            {job.automation_name && (
                              <span className="text-xs px-2 py-0.5 rounded bg-[rgba(99,102,241,0.15)] text-[#818cf8]">
                                {job.automation_name}
                              </span>
                            )}
                            {(() => {
                              const execMode = (() => { try { const d = JSON.parse(job.input_data || '{}'); return d.execution_mode; } catch { return null; } })();
                              const isGithub = job.github_run_id || execMode === "github";
                              if (isGithub) {
                                return <span className="text-xs px-2 py-0.5 rounded bg-[rgba(59,130,246,0.15)] text-[#3b82f6]">GitHub Actions runner</span>;
                              }
                              if (job.status === "running") {
                                return <span className="text-xs px-2 py-0.5 rounded bg-[rgba(245,158,11,0.15)] text-[#f59e0b]">Local runner processing on this PC</span>;
                              }
                              if (job.status === "queued") {
                                return <span className="text-xs px-2 py-0.5 rounded bg-[rgba(99,102,241,0.15)] text-[#818cf8]">Waiting for local runner</span>;
                              }
                              return null;
                            })()}
                            {(videoUrl || localVideoUrl) && (
                              <span className="text-xs text-[#22c55e]">
                                {hasLocalPreview ? "Local video ready" : (previewUrls.length > 1 ? previewUrls.length + " videos" : "Video ready")}
                              </span>
                            )}
                            {fetchStats && (
                              <span className="text-xs px-2 py-0.5 rounded bg-[rgba(99,102,241,0.15)] text-[#818cf8]">
                                {fetchStats.total} fetched / {fetchStats.unprocessed} new / {fetchStats.to_process} processing
                              </span>
                            )}
                            {videoUrls.length > 0 && !fetchStats && (
                              <span className="text-xs px-2 py-0.5 rounded bg-[rgba(99,102,241,0.15)] text-[#818cf8]">
                                {videoUrls.length} URLs
                              </span>
                            )}
                            <span className="text-xs text-[#a1a1aa]">
                              {new Date(job.created_at).toLocaleString()}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {job.status === "failed" && (
                          <button onClick={() => handleRetry(job.id)} className="glass-button text-sm py-2 px-4 text-[#f59e0b]">
                            Retry
                          </button>
                        )}
                        {(job.status === "running" || job.status === "queued") && (
                          <button onClick={() => handleForceContinue(job.id)} className="glass-button text-sm py-2 px-4 text-[#f97316]">
                            Force Continue
                          </button>
                        )}
                        {job.github_run_url && (
                          <>
                            <a href={job.github_run_url} target="_blank" rel="noopener" className="glass-button text-sm py-2 px-4">
                              GitHub
                            </a>
                            <a href={`${job.github_run_url}/artifacts`} target="_blank" rel="noopener" className="glass-button text-sm py-2 px-4 text-emerald-300">
                              Artifacts
                            </a>
                          </>
                        )}
                        <button
                          onClick={() => setDeleteJobId(job.id)}
                          className="glass-button text-sm py-2 px-4 text-[#ef4444]"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {localVideoPath && (
                      <div className="mt-3 p-3 rounded-xl bg-[rgba(34,197,94,0.08)] border border-[rgba(34,197,94,0.2)]">
                        <p className="text-xs text-[#22c55e] break-all">Local output: {localVideoPath}</p>
                      </div>
                    )}

                    {previewUrls.length > 0 && (
                      <div className="mt-4 flex flex-wrap gap-4 justify-center">
                        {previewUrls.map((url, idx) => (
                          <div key={idx} className="flex flex-col items-center">
                            <span className="text-xs text-[#a1a1aa] mb-1">Short {idx + 1}/{previewUrls.length}</span>
                            <VideoPlayer videoUrl={url} />
                          </div>
                        ))}
                      </div>
                    )}

                    {job.error_message && (
                      <div className="mt-3 p-3 rounded-xl bg-[rgba(239,68,68,0.1)] border border-[rgba(239,68,68,0.2)]">
                        <p className="text-xs text-[#ef4444]">{job.error_message}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {activeTab === "management" && (
        <div className="space-y-6">
          {statsLoading ? (
            <div className="text-center py-16 text-[#a1a1aa]">Loading stats...</div>
          ) : !stats ? (
            <div className="glass-card p-12 text-center">
              <p className="text-lg font-medium">Could not load database stats</p>
            </div>
          ) : (
            <>
              <div className="glass-card p-6">
                <h3 className="text-lg font-semibold mb-4">Database Usage</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
                  <StatCard label="Total Jobs" value={stats.total_jobs} />
                  <StatCard label="Success" value={stats.success_jobs} color="text-[#22c55e]" />
                  <StatCard label="Failed" value={stats.failed_jobs} color="text-[#ef4444]" />
                  <StatCard label="Running" value={stats.running_jobs} color="text-[#f59e0b]" />
                  <StatCard label="Queued" value={stats.queued_jobs} color="text-[#818cf8]" />
                  <StatCard label="Cancelled" value={stats.cancelled_jobs} color="text-[#a1a1aa]" />
                  <StatCard label="Processed Videos" value={stats.total_processed_videos} />
                  <StatCard label="Video Uploads" value={stats.total_video_uploads} />
                  <StatCard label=">7 days old" value={stats.completed_before_7d} color="text-[#f97316]" />
                  <StatCard label=">30 days old" value={stats.completed_before_30d} color="text-[#ef4444]" />
                </div>
                {stats.oldest_job_date && (
                  <p className="text-xs text-[#a1a1aa] mt-4">
                    Oldest job: {new Date(stats.oldest_job_date).toLocaleDateString()}
                  </p>
                )}
              </div>

              <div className="glass-card p-6">
                <h3 className="text-lg font-semibold mb-4">Cleanup Actions</h3>
                <div className="space-y-3">
                  <button
                    onClick={() => setShowDeleteCompletedConfirm(true)}
                    disabled={completedCount === 0}
                    className="w-full glass-button py-3 px-4 text-left flex items-center justify-between disabled:opacity-40"
                  >
                    <span>Delete All Completed Jobs</span>
                    <span className="text-sm text-[#a1a1aa]">{completedCount} job(s)</span>
                  </button>

                  <div className="flex gap-3 items-center flex-wrap">
                    <input
                      type="date"
                      value={deleteOldDate}
                      onChange={(e) => setDeleteOldDate(e.target.value)}
                      className="glass-input flex-1 min-w-[180px] px-4 py-2.5 rounded-xl bg-[rgba(255,255,255,0.05)] border border-[rgba(255,255,255,0.1)] text-sm"
                    />
                    <button
                      onClick={() => setShowDeleteOldConfirm(true)}
                      disabled={!deleteOldDate}
                      className="glass-button py-2.5 px-4 text-[#f97316] disabled:opacity-40"
                    >
                      Delete Older Than Date
                    </button>
                  </div>

                  <button
                    onClick={() => setShowDeleteAllConfirm(true)}
                    disabled={stats.total_jobs === 0}
                    className="w-full glass-button py-3 px-4 text-left flex items-center justify-between text-[#ef4444] disabled:opacity-40"
                  >
                    <span>Delete All Jobs</span>
                    <span className="text-sm text-[#a1a1aa]">{stats.total_jobs} job(s)</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Delete All Jobs Confirmation Modal */}
      {showDeleteAllConfirm && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowDeleteAllConfirm(false)}
        >
          <div
            className="glass-card p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold mb-4">Delete All Jobs?</h3>
            <p className="text-[#a1a1aa] mb-6">
              Are you sure you want to delete all {stats?.total_jobs || ""} jobs? This will also delete all processed videos and uploads. This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteAllConfirm(false)}
                className="glass-button py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteAllJobs}
                className="glass-button py-2 px-4 text-[#ef4444]"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Completed Jobs Confirmation Modal */}
      {showDeleteCompletedConfirm && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowDeleteCompletedConfirm(false)}
        >
          <div
            className="glass-card p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold mb-4">Delete Completed Jobs?</h3>
            <p className="text-[#a1a1aa] mb-6">
              Delete all {completedCount} completed (success, failed, cancelled) jobs? Their processed videos and uploads will also be removed. Running/queued jobs are kept.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteCompletedConfirm(false)}
                className="glass-button py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteCompletedJobs}
                disabled={deletingCompleted}
                className="glass-button py-2 px-4 text-[#ef4444]"
              >
                {deletingCompleted ? "Deleting..." : "Delete Completed"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Old Jobs Confirmation Modal */}
      {showDeleteOldConfirm && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowDeleteOldConfirm(false)}
        >
          <div
            className="glass-card p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold mb-4">Delete Old Jobs?</h3>
            <p className="text-[#a1a1aa] mb-6">
              Delete all jobs completed before {new Date(deleteOldDate).toLocaleDateString()}? Their processed videos and uploads will also be removed.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowDeleteOldConfirm(false)}
                className="glass-button py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteOldJobs}
                disabled={deletingOld}
                className="glass-button py-2 px-4 text-[#ef4444]"
              >
                {deletingOld ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Single Job Confirmation Modal */}
      {deleteJobId !== null && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setDeleteJobId(null)}
        >
          <div
            className="glass-card p-8 max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold mb-4">Delete Job #{deleteJobId}?</h3>
            <p className="text-[#a1a1aa] mb-6">
              Are you sure you want to delete this job? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteJobId(null)}
                className="glass-button py-2 px-4"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteJob(deleteJobId)}
                className="glass-button py-2 px-4 text-[#ef4444]"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-xl bg-[rgba(255,255,255,0.03)] border border-[rgba(255,255,255,0.06)] p-4">
      <p className="text-xs text-[#a1a1aa]">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color || "text-white"}`}>{value}</p>
    </div>
  );
}
