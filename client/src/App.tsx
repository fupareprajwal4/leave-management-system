
import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import AppShell from "./layouts/AppShell";
import type { Role } from "./types";
import FacultyDashboard from "./pages/faculty/Dashboard";
import NewApplication from "./pages/faculty/NewApplication";
import Applications from "./pages/faculty/Applications";
import Balances from "./pages/faculty/Balances";
import HodDashboard from "./pages/hod/Dashboard";
import HodRequests from "./pages/hod/Requests";
import HodFaculty from "./pages/hod/Faculty";
import AccessRequests from "./pages/admin/AccessRequests";
import AdminDashboard from "./pages/admin/Dashboard";
import AdminRequests from "./pages/admin/Requests";
import AdminFaculty from "./pages/admin/Faculty";
import AdminPolicies from "./pages/admin/Policies";
import AdminReports from "./pages/admin/Reports";
import AdminLeaveBalances from "./pages/admin/LeaveBalances";
import { GraduationCap } from "lucide-react";
import Login from "./pages/Login";
import { api } from "./services/api";

const demo = import.meta.env.VITE_DEMO_MODE === "true";

function Loading() {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="eyebrow">SGGSIE&T · LEAVE PORTAL</div>
        <h1>Checking your session…</h1>
        <p>Please wait while we verify your institutional account.</p>
      </div>
    </div>
  );
}

export default function App() {
  const [role, setRole] = useState<Role>("faculty");
  const [ready, setReady] = useState(demo);
  const [signedIn, setSignedIn] = useState(demo);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    if (demo) {
      setReady(true);
      setSignedIn(true);
      return;
    }

    let active = true;

    api
      .get("/auth/me")
      .then((r) => {
        if (!active) return;
        setUser(r.data.data);
        setRole(r.data.data.role);
        setSignedIn(true);
      })
      .catch(() => {
        if (active) setSignedIn(false);
      })
      .finally(() => {
        if (active) setReady(true);
      });

    const onUnauthorized = () => {
      setSignedIn(false);
      setUser(null);
    };

    window.addEventListener("sggs:unauthorized", onUnauthorized);

    return () => {
      active = false;
      window.removeEventListener("sggs:unauthorized", onUnauthorized);
    };
  }, []);

  if (!ready) return <Loading />;

  return (
    <Routes>
      <Route
        path="/login"
        element={signedIn ? <Navigate to={`/${role}`} replace /> : <Login />}
      />

      <Route
        path="/access-denied"
        element={
          <div className="login-page">
            <div className="login-card">
              <h1>Access denied</h1>
              <p>
                This Google account is not authorized for the SGGSIE&T Leave
                Portal. If you believe this is an error, contact the
                Establishment Section.
              </p>
              <a
                className="btn btn-primary"
                href={
                  (import.meta.env.VITE_API_URL || "/api/v1") + "/auth/google"
                }
              >
                Try another account
              </a>
              <div className="login-divider" />
              <a href="/login">Back to login</a>
            </div>
          </div>
        }
      />

      <Route
        path="/access-pending"
        element={
          <div className="login-page">
            <div className="login-brand">
              <div className="brand-mark">
                <GraduationCap size={24} />
              </div>
              <div>
                <b>
                  SGGS <span>Leave Portal</span>
                </b>
                <small>Faculty services · Nanded</small>
              </div>
            </div>
            <div className="login-card">
              <div className="login-seal">
                <GraduationCap size={28} />
              </div>
              <div className="eyebrow">ACCESS REQUEST</div>
              <h1>Request received.</h1>
              <p>
                Your Google account has been verified. An administrator must
                review and approve your portal access before you can use
                leave-management features.
              </p>
              <div className="login-security">
                <span>
                  After approval, return here and sign in with the same Google
                  account.
                </span>
              </div>
              <a
                className="btn btn-primary google-btn"
                href={
                  (import.meta.env.VITE_API_URL || "/api/v1") + "/auth/google"
                }
              >
                Check access again
              </a>
              <div className="login-divider" />
              <a href="/login">Back to login</a>
            </div>
            <div className="login-address">
              Vishnupuri, Nanded, Maharashtra – 431606, India
            </div>
          </div>
        }
      />

      <Route
        element={
          signedIn ? (
            <AppShell
              role={role}
              setRole={setRole}
              user={user}
              demoMode={demo}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      >
        <Route index element={<Navigate to={`/${role}`} replace />} />

        <Route
          path="faculty"
          element={
            role === "faculty" || role === "hod" ? (
              <FacultyDashboard />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="faculty/new"
          element={
            role === "faculty" || role === "hod" ? (
              <NewApplication />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="faculty/applications"
          element={
            role === "faculty" || role === "hod" ? (
              <Applications />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="faculty/balances"
          element={
            role === "faculty" || role === "hod" ? (
              <Balances />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="hod"
          element={
            role === "hod" ? (
              <HodDashboard />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="hod/requests"
          element={
            role === "hod" ? (
              <HodRequests />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="hod/faculty"
          element={
            role === "hod" ? (
              <HodFaculty />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin"
          element={
            role === "admin" ? (
              <AdminDashboard />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/requests"
          element={
            role === "admin" ? (
              <AdminRequests />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/faculty"
          element={
            role === "admin" ? (
              <AdminFaculty />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/balances"
          element={
            role === "admin" ? (
              <AdminLeaveBalances />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/policies"
          element={
            role === "admin" ? (
              <AdminPolicies />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/reports"
          element={
            role === "admin" ? (
              <AdminReports />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="admin/access-requests"
          element={
            role === "admin" ? (
              <AccessRequests />
            ) : (
              <Navigate to={`/${role}`} replace />
            )
          }
        />

        <Route
          path="*"
          element={
            <div className="panel not-found">
              <div className="brand-mark">
                <GraduationCap />
              </div>
              <h1>Page not found</h1>
              <p>The page may have moved or you may not have access.</p>
              <a className="btn btn-primary" href="/">
                Return to workspace
              </a>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
