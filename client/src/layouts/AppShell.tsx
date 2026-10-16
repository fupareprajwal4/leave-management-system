
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  LayoutDashboard,
  FilePlus2,
  Files,
  WalletCards,
  Users,
  ClipboardCheck,
  Settings2,
  ChartNoAxesCombined,
  Bell,
  Search,
  LogOut,
  Menu,
  X,
  CalendarDays,
  ShieldCheck,
} from "lucide-react";
import Brand from "../components/Brand";
import type { Role } from "../types";

const nav: Record<
  Role,
  { label: string; items: { to: string; label: string; icon: any }[] }
> = {
  faculty: {
    label: "FACULTY WORKSPACE",
    items: [
      { to: "/faculty", label: "Overview", icon: LayoutDashboard },
      { to: "/faculty/new", label: "New application", icon: FilePlus2 },
      { to: "/faculty/applications", label: "My applications", icon: Files },
      { to: "/faculty/balances", label: "Leave balances", icon: WalletCards },
    ],
  },
  hod: {
    label: "DEPARTMENT WORKSPACE",
    items: [
      { to: "/hod", label: "Overview", icon: LayoutDashboard },
      { to: "/hod/requests", label: "Review requests", icon: ClipboardCheck },
      { to: "/hod/faculty", label: "Department faculty", icon: Users },
      { to: "/faculty/new", label: "My leave application", icon: FilePlus2 },
      { to: "/faculty/applications", label: "My applications", icon: Files },
      { to: "/faculty/balances", label: "My leave balances", icon: WalletCards },
    ],
  },
  admin: {
    label: "ESTABLISHMENT",
    items: [
      { to: "/admin", label: "Overview", icon: LayoutDashboard },
      {
        to: "/admin/requests",
        label: "Application review",
        icon: ClipboardCheck,
      },
      { to: "/admin/faculty", label: "People & departments", icon: Users },
      { to: "/admin/balances", label: "Faculty leave balances", icon: WalletCards },
      { to: "/admin/policies", label: "Leave policies", icon: Settings2 },
      {
        to: "/admin/reports",
        label: "Reports & audit",
        icon: ChartNoAxesCombined,
      },
      {
        to: "/admin/access-requests",
        label: "Access requests",
        icon: ShieldCheck,
      },
    ],
  },
};

export default function AppShell({
  role,
  setRole,
  user,
  demoMode = false,
}: {
  role: Role;
  setRole: (r: Role) => void;
  user?: any;
  demoMode?: boolean;
}) {
  const [mobile, setMobile] = useState(false);
  const navigate = useNavigate();
  const config = nav[role];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <Brand />
        <div className="workspace-label">{config.label}</div>
        <nav>
          {config.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={
                  item.to === "/faculty" ||
                  item.to === "/hod" ||
                  item.to === "/admin"
                }
                onClick={() => setMobile(false)}
                className={({ isActive }) =>
                  `nav-item ${isActive ? "active" : ""}`
                }
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="secure-note">
            <ShieldCheck size={18} />
            <div>
              <b>Secure workspace</b>
              <small>Access is role controlled</small>
            </div>
          </div>
          <div className="institute-mini">
            <span className="institute-seal">S</span>
            <div>
              <b>SGGSIE&T</b>
              <small>Vishnupuri, Nanded</small>
            </div>
          </div>
        </div>
      </aside>

      {mobile && (
        <button
          className="mobile-scrim"
          onClick={() => setMobile(false)}
          aria-label="Close menu"
        />
      )}

      <main className="main-area">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            onClick={() => setMobile(!mobile)}
            aria-label="Toggle navigation"
          >
            {mobile ? <X /> : <Menu />}
          </button>

          <div className="breadcrumb">
            <span>Workspace</span>
            <span className="crumb-dot">/</span>
            <b>
              {role === "faculty"
                ? "Faculty"
                : role === "hod"
                  ? "Head of Department"
                  : "Establishment Section"}
            </b>
          </div>

          <div className="top-actions">
            <div className="search-box">
              <Search size={16} />
              <input
                placeholder="Search applications"
                aria-label="Search applications"
              />
            </div>

            <button
              className="icon-button notification"
              aria-label="Notifications"
            >
              <Bell size={18} />
              <i />
            </button>

            <button
              className="user-menu"
              onClick={async () => {
                try {
                  await (
                    await import("../services/api")
                  ).api.post("/auth/logout");
                } finally {
                  window.location.assign("/login");
                }
              }}
              title="Sign out"
            >
              <div className="avatar">
                {(
                  user?.name ||
                  (role === "faculty" ? "FA" : role === "hod" ? "HD" : "AD")
                )
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div className="user-meta">
                <b>
                  {user?.name ||
                    (role === "faculty"
                      ? "Faculty Member"
                      : role === "hod"
                        ? "Department HOD"
                        : "Establishment Admin")}
                </b>
                <small>
                  {user?.email ||
                    (role === "faculty"
                      ? "Faculty account"
                      : role === "hod"
                        ? "Department office"
                        : "Establishment access")}
                </small>
              </div>
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {demoMode && (
          <div className="demo-strip">
            <span>
              <i /> DEMO PREVIEW
            </span>
            <span>
              Demo mode is for UI review only and must never be enabled for
              production.
            </span>
            <label>
              Preview role{" "}
              <select
                value={role}
                onChange={(e) => {
                  setRole(e.target.value as Role);
                  navigate("/" + e.target.value);
                }}
              >
                <option value="faculty">Faculty</option>
                <option value="hod">HOD</option>
                <option value="admin">Admin / Establishment</option>
              </select>
            </label>
          </div>
        )}

        <div className="page-content">
          <Outlet />
        </div>

        <footer className="footer">
          <span>
            © {new Date().getFullYear()} SGGSIE&T · Leave Management System
          </span>
          <span>
            <CalendarDays size={14} /> Calendar year policy · Asia/Kolkata
          </span>
        </footer>
      </main>
    </div>
  );
}
