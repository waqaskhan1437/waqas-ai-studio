"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clearStoredAccessToken } from "@/lib/auth";
import { HOSTED_FRONTEND_URL } from "@/lib/constants";

const links = [
  { href: "/", label: "Dashboard", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" },
  { href: "/settings", label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
  { href: "/ai-access", label: "AI Access", icon: "M12 6V4m0 16v-2m8-6h-2M6 12H4m12.95 4.95l-1.414-1.414M8.464 8.464L7.05 7.05m9.9 0l-1.414 1.414M8.464 15.536L7.05 16.95M12 8a4 4 0 100 8 4 4 0 000-8z" },
  { href: "/automations", label: "Automations", icon: "M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" },
  { href: "/ai-video", label: "AI Video Generator", icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" },
  { href: "/dubbing", label: "Dubbing", icon: "M9 9v6h4l5 5V4l-5 5H9z M5 9h2v6H5a2 2 0 01-2-2v-2a2 2 0 012-2z" },
  { href: "/output", label: "Output", icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" },
  { href: "/jobs", label: "Jobs", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const isLocalOrigin = typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-[#12121a] border-r border-[rgba(255,255,255,0.08)] p-6 flex flex-col">
      <div className="mb-8">
        <h1 className="text-xl font-bold bg-gradient-to-r from-[#6366f1] to-[#8b5cf6] bg-clip-text text-transparent">
          Automation
        </h1>
        <p className="text-xs text-[#a1a1aa] mt-1">Social Media System</p>
      </div>

      <nav className="flex-1 flex flex-col gap-1">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={`sidebar-link ${pathname === link.href ? "active" : ""}`}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={link.icon} />
            </svg>
            {link.label}
          </Link>
        ))}
      </nav>

      <div className="glass-card p-4 mt-auto">
        <p className="text-xs text-[#a1a1aa]">System Status</p>
        <div className="flex items-center gap-2 mt-2">
          <div className="w-2 h-2 rounded-full bg-[#10b981] animate-pulse"></div>
          <span className="text-sm font-medium">Online</span>
        </div>
        <button
          onClick={() => {
            clearStoredAccessToken();
            if (isLocalOrigin) {
              window.location.href = "/logout";
              return;
            }
            window.location.href = `${HOSTED_FRONTEND_URL}/adminlogin`;
          }}
          className="mt-4 text-xs text-[#a1a1aa] hover:text-white"
        >
          Sign Out
        </button>
      </div>
    </aside>
  );
}
