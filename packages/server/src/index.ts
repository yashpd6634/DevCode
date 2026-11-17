import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import * as Sentry from "@sentry/hono/bun";
import { requireAuth } from "./middleware/require-auth";
import sessions from "./routes/sessions";
import { sentry } from "@sentry/hono/bun";
import chat from "./routes/chat";
import auth from "./routes/auth";
import billing from "./routes/billing";

const app = new Hono();

app.use(
  sentry(app, {
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    // Sentry's VercelAI integration wraps the AI SDK's model streams and leaves
    // them locked, so every streamText() call fails with "The ReadableStream is
    // locked". Remove it until the integration supports `ai` v7.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "VercelAI"),
  }),
);

app.get("/debug-sentry", () => {
  // Send a log before throwing the error
  Sentry.logger.info("User triggered test error", {
    action: "test_error_endpoint",
  });
  // Send a test metric before throwing the error
  Sentry.metrics.count("test_counter", 1);
  throw new Error("My first Sentry error!");
});

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    Sentry.logger.warn("Handled HTTP error", {
      status: error.status,
      message: error.message || "Request failed",
      path: c.req.path,
      method: c.req.method,
    });

    return c.json(
      {
        error: error.message || "Request failed",
      },
      error.status,
    );
  }

  Sentry.logger.error("Unhandled server error", {
    path: c.req.path,
    method: c.req.method,
    message: error instanceof Error ? error.message : "Unknown error",
  });

  console.error("Unhandled server error", error);
  return c.json({ error: "Internal server error" }, 500);
});

app.use("/sessions/*", requireAuth);
app.use("/chat/*", requireAuth);
app.use("/billing/checkout", requireAuth);
app.use("/billing/portal", requireAuth);

const routes = app
  .route("/auth", auth)
  .route("/billing", billing)
  .route("/sessions", sessions)
  .route("/chat", chat);

export type AppType = typeof routes;
// idleTimeout must be high, otherwise LLM tool calls might not complete
export default { port: 3000, fetch: app.fetch, idleTimeout: 255 };
