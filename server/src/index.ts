import express from "express";
import cors from "cors";
import helmet from "helmet";
import session from "express-session";
import MongoStore from "connect-mongo";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import crypto from "node:crypto";
import mongoose from "mongoose";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { env } from "./config/env.js";
import { router } from "./routes/index.js";
import { AccessRequest, User } from "./models/index.js";
import { errorHandler } from "./utils/errors.js";
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const id = crypto.randomUUID();
  (req as any).requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
});
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = new Set(
        [
          env.CLIENT_URL,
          process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
          process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : "",
        ].filter(Boolean),
      );
      if (!origin || allowed.has(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS."));
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(
  session({
    name: "sggs.sid",
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store:
      env.NODE_ENV === "test"
        ? undefined
        : MongoStore.create({
            mongoUrl: env.MONGODB_URI,
            collectionName: "sessions",
          }),
    cookie: {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000,
    },
  }),
);
app.use(passport.initialize());
app.use(passport.session());
passport.serializeUser((user: any, done) => done(null, user.id));
passport.deserializeUser(async (id: string, done) => {
  try {
    done(null, await User.findById(id));
  } catch (e) {
    done(e);
  }
});
const googleConfigured = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_CALLBACK_URL,
);
if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: env.GOOGLE_CLIENT_ID!,
        clientSecret: env.GOOGLE_CLIENT_SECRET!,
        callbackURL: env.GOOGLE_CALLBACK_URL!,
      },
      async (_access, _refresh, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.trim().toLowerCase();
          const verified = (profile as any)._json?.email_verified === true;
          if (!email || !verified) return done(null, false);
          return done(null, {
            googleSub: profile.id,
            email,
            name: profile.displayName?.trim() || email.split("@")[0],
          } as any);
        } catch (e) {
          return done(e as Error);
        }
      },
    ),
  );
  app.get(
    "/api/v1/auth/google",
    passport.authenticate("google", {
      scope: ["profile", "email"],
      session: false,
    }),
  );
  app.get("/api/v1/auth/google/callback", (req, res, next) => {
    passport.authenticate(
      "google",
      { session: false },
      async (error: Error | null, identity: any) => {
        if (error) {
          console.error("[Google OAuth] Callback failed:", error);
          return res.redirect(`${env.CLIENT_URL}/login?auth=error`);
        }
        if (!identity?.email || !identity?.googleSub)
          return res.redirect(`${env.CLIENT_URL}/access-denied`);
        try {
          const email = String(identity.email).trim().toLowerCase();
          const user = await User.findOne({ email });
          if (user) {
            if (!user.emailVerified || !user.active || !user.provisioned)
              return res.redirect(`${env.CLIENT_URL}/access-denied`);
            if (user.googleSub && user.googleSub !== identity.googleSub)
              return res.redirect(`${env.CLIENT_URL}/access-denied`);
            if (!user.googleSub) {
              user.googleSub = identity.googleSub;
              await user.save();
            }
            return req.logIn(user, (loginError) => {
              if (loginError) {
                console.error(
                  "[Google OAuth] Login session failed:",
                  loginError,
                );
                return res.redirect(`${env.CLIENT_URL}/login?auth=error`);
              }
              (req.session as any).userId = String(user._id);
              req.session.save((saveError) => {
                if (saveError) {
                  console.error(
                    "[Google OAuth] Session save failed:",
                    saveError,
                  );
                  return res.redirect(`${env.CLIENT_URL}/login?auth=error`);
                }
                return res.redirect(env.CLIENT_URL);
              });
            });
          }
          let request;
          try {
            request = await AccessRequest.findOneAndUpdate(
              { email },
              {
                $setOnInsert: {
                  email,
                  googleSub: identity.googleSub,
                  name: identity.name,
                  status: "pending",
                },
              },
              { new: true, upsert: true, setDefaultsOnInsert: true },
            );
          } catch (createError: any) {
            if (createError?.code !== 11000) throw createError;
            request = await AccessRequest.findOne({ email });
          }
          if (!request || request.googleSub !== identity.googleSub)
            return res.redirect(`${env.CLIENT_URL}/access-denied`);
          if (request.status === "rejected")
            return res.redirect(`${env.CLIENT_URL}/access-denied`);
          if (request.status === "approved") {
            console.error(
              "[Google OAuth] Approved request has no provisioned user:",
              email,
            );
            return res.redirect(`${env.CLIENT_URL}/login?auth=error`);
          }
          // Do not leave an older authenticated session active when a different,
          // unprovisioned Google identity begins a registration request.
          return req.session.destroy((destroyError) => {
            res.clearCookie("sggs.sid");
            if (destroyError)
              console.error(
                "[Google OAuth] Could not clear prior session:",
                destroyError,
              );
            return res.redirect(`${env.CLIENT_URL}/access-pending`);
          });
        } catch (callbackError) {
          console.error(
            "[Google OAuth] Access-request flow failed:",
            callbackError,
          );
          return res.redirect(`${env.CLIENT_URL}/login?auth=error`);
        }
      },
    )(req, res, next);
  });
} else {
  app.get("/api/v1/auth/google", (_req, res) =>
    res
      .status(503)
      .json({
        error: {
          code: "OAUTH_NOT_CONFIGURED",
          message: "Google OAuth is not configured on this server.",
        },
      }),
  );
  app.get("/api/v1/auth/google/callback", (_req, res) =>
    res.status(503).end("Google OAuth is not configured."),
  );
}
app.get(["/health", "/api/health"], (_req, res) =>
  res.json({
    status: "ok",
    service: "sggs-leave-api",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    time: new Date().toISOString(),
  }),
);
app.use("/api/v1", router);
app.use((req, res) =>
  res
    .status(404)
    .json({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
        requestId: (req as any).requestId,
      },
    }),
);
app.use(errorHandler);
async function start() {
  await mongoose.connect(env.MONGODB_URI);
  const server = app.listen(env.PORT, () =>
    console.log(
      JSON.stringify({
        level: "info",
        message: "API listening",
        port: env.PORT,
        environment: env.NODE_ENV,
      }),
    ),
  );
  const shutdown = () =>
    server.close(() => mongoose.disconnect().finally(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
if (process.env.RUN_HTTP_SERVER === "true" && process.env.NODE_ENV !== "test")
  start().catch((err) => {
    console.error("Server startup failed:", err.message);
    process.exit(1);
  });
export default app;
