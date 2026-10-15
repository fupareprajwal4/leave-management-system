import { GraduationCap, ShieldCheck, ArrowRight } from "lucide-react";
export default function Login() {
  const authError = new URLSearchParams(window.location.search).get("auth") === "error";
  return (
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
        <div className="eyebrow">SHRI GURU GOBIND SINGHJI INSTITUTE</div>
        <h1>
          Leave management,
          <br />
          made simpler.
        </h1>
        <p>
          Securely apply for leave, follow approvals and access your official
          records in one place.
        </p>
        {authError && (
          <div className="error-banner" role="alert">
            Sign-in could not be completed. Please try again. If your access was
            recently approved, ask the administrator to verify that your user
            account is active and provisioned.
          </div>
        )}
        <a
          className="btn btn-primary google-btn"
          href={(import.meta.env.VITE_API_URL || "/api/v1") + "/auth/google"}
        >
          Continue with Google <ArrowRight size={16} />
        </a>
        <div className="login-security">
          <ShieldCheck size={17} />
          <span>Access is limited to institute-provisioned accounts.</span>
        </div>
        <div className="login-divider" />
        <div className="login-foot">
          <b>First time here?</b>
          <span>
            Continue with Google to submit an access request. An administrator
            will review it before you can use the portal.
          </span>
        </div>
      </div>
      <div className="login-address">
        Vishnupuri, Nanded, Maharashtra – 431606, India
      </div>
    </div>
  );
}
