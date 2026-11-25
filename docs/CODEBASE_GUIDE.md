# DevCode codebase guide

A map for reading this project from the first line to the last. Keep it open next to the code: every section names the files to open and the lines to look at, and explains **what** the code does and **why** it was built that way.

Links are relative to this file, so they open the right file (and line) from VS Code's Markdown preview.

---

## How to use this guide

| Part | What it gives you | When to read it |
|---|---|---|
| [1. Mental model](#part-1--the-mental-model) | The big picture: processes, packages, design decisions | First, before any code (~10 min) |
| [2. Reading order](#part-2--reading-order) | A numbered path through every important file, in the order that makes sense | Second, with the code open beside it (~5 hours total, split into stages) |
| [3. Feature walkthroughs](#part-3--feature-walkthroughs) | Each feature traced end to end across CLI and server | While reading, or later when you want to understand one feature |
| [4. TypeScript patterns](#part-4--typescript-patterns-used-here) | Every TS technique the code relies on, with where it appears | Whenever a type looks strange |
| [5. Reference](#part-5--reference) | HTTP API, env vars, stored data shape, glossary | Look things up |
| [6. Known gaps](#part-6--known-gaps-and-things-to-watch) | What is unfinished or fragile | After you understand the flow |
| [7. Self-check](#part-7--self-check) | Questions to test your understanding | At the end |

---

## Part 1 — The mental model

### What DevCode is

DevCode is an AI coding assistant that runs in your terminal. You start it inside a project folder, type a request, and a language model answers. The model can also **read, search, edit and run things in that folder** through tools.

### The three places code runs

```
 YOUR MACHINE                               THE SERVER                         OTHER SERVICES
┌──────────────────────────────────┐        ┌──────────────────────────────┐
│ packages/cli  (Bun + OpenTUI)    │  HTTP  │ packages/server (Bun + Hono) │──▶ OpenAI / Anthropic / Google (LLMs)
│                                  │ ─────▶ │                              │──▶ Clerk     (login, token checks)
│  • terminal UI (React)           │        │  • checks who you are        │──▶ Polar     (credits, payments)
│  • useChat: sends + streams chat │ ◀───── │  • checks you have credits   │──▶ Postgres  (sessions, via Prisma)
│  • runs tools on YOUR files      │ stream │  • calls the LLM, streams it │──▶ Sentry    (errors, logs)
│  • ~/.devcode/auth.json (token)  │        │  • saves history, bills you  │
└──────────────────────────────────┘        └──────────────────────────────┘
          │ reads / writes / runs
          ▼
   the project folder you launched DevCode in
```

### Five design decisions that explain most of the code

1. **The server holds every secret.** LLM API keys, the Clerk secret and the Polar token live only on the server. The CLI never talks to OpenAI directly. That is also what makes billing possible: every model call passes through code you control.
2. **Tools run on the client, not the server.** The server may be in the cloud and cannot see your disk. So the server only *declares* the tools (name + input schema). When the model calls one, the CLI runs it locally and sends the result back. This is the most important idea in the project; see [F2](#f2-the-tool-calling-loop).
3. **`packages/shared` is the contract.** The model list, the modes and the tool schemas are defined once and imported by both sides, so the CLI and server can't disagree about shapes.
4. **The Vercel AI SDK does the chat plumbing.** On the server, `streamText` talks to any provider and produces a standard stream. On the client, `useChat` consumes it and keeps the message list. Very little streaming code is hand-written.
5. **A conversation is stored as one JSON array.** Each session row has a `messages` JSON column holding the AI SDK's own message objects. No message table and no per-part tables.

### The monorepo

```
dev-code/
├─ package.json            workspaces + root scripts (dev:cli, dev:server, build:cli, link:cli)
├─ tsconfig.base.json      strict TS settings shared by every package
├─ .env                    secrets for server + CLI (never commit)
└─ packages/
   ├─ shared/     contract: models + prices, modes, tool schemas       (used by cli + server)
   ├─ database/   Prisma schema + generated client + db connection      (used by server)
   ├─ server/     Hono API: auth, sessions, chat, billing                (uses shared + database)
   └─ cli/        terminal app: screens, providers, chat hook, tools     (uses shared; imports server TYPES only)
```

Dependency direction: `cli → shared`, `server → shared + database`. The CLI also imports `AppType` from the server, but only as a **type** (`import type`), so no server code ships in the CLI. That one type is what gives the CLI typed API calls (see [F8](#f8-how-api-requests-are-authenticated)).

### How to run it

```bash
bun install              # also runs `prisma generate` (server postinstall)
# fill in .env (see Part 5 for every variable)
bun run dev:server       # http://localhost:3000, hot reload
bun run dev:cli          # in the project folder you want the AI to work on
```

---

## Part 2 — Reading order

Five stages. Finish a stage before moving on; each one assumes the previous ones.

### Stage A — The contract (≈30 min)

**A1. [package.json](../package.json) and [tsconfig.base.json](../tsconfig.base.json)**
- `workspaces: ["packages/*"]` is what makes `@devcode/shared` importable like an npm package.
- In tsconfig, note `strict`, and especially **`noUncheckedIndexedAccess`**: `array[i]` has type `T | undefined`. That single flag explains the many `!` and `?.` you'll see (e.g. `messages[messages.length - 1]` must be checked).
- `"module": "Preserve"` + `"moduleResolution": "bundler"` = "let Bun handle imports".

**A2. [shared/src/models.ts](../packages/shared/src/models.ts)**: the list of models you can pick.
- `SUPPORTED_CHAT_MODELS` is an array of `{ id, provider, pricing }`.
- [L87](../packages/shared/src/models.ts#L87): `as const satisfies readonly SupportedChatModelDefinition[]`. `as const` keeps the exact ids (`"gpt-5.4-nano"`, not `string`); `satisfies` still checks every entry has the right shape.
- [L89-L90](../packages/shared/src/models.ts#L89-L90): the types are **derived from the data**: `SupportedChatModelId` is the union of all ids. Add a model to the array and the type updates itself.
- `pricing` is used later for billing ([F9](#f9-credits-and-billing)).

**A3. [shared/src/schemas.ts](../packages/shared/src/schemas.ts)**: modes and tools.
- `Mode` + `ModeType`: `"BUILD" | "PLAN"`, as a const object plus a derived union type (no `enum`).
- `toolInputSchemas`: one Zod schema per tool. `.describe()` text is sent to the model as parameter documentation, so these strings also act as prompts.
- `readOnlyToolContracts` / `buildToolContracts`: `tool({ description, inputSchema })` from the AI SDK. **There is no `execute` function**: that is what makes them *client-side* tools. BUILD spreads in the read-only set and adds `writeFile`, `editFile`, `bash`.
- `getToolContracts(mode)`: PLAN gets read-only tools only. This is one of the three ways PLAN mode is enforced ([F4](#f4-plan-vs-build-modes)).

**A4. [shared/src/index.ts](../packages/shared/src/index.ts)**: the package's public surface. Anything not exported here is private to `shared`.

**A5. Database: [schema.prisma](../packages/database/prisma/schema.prisma), [client.ts](../packages/database/src/client.ts), [prisma.config.ts](../packages/database/prisma.config.ts)**
- One model: `Session { id, userId, title, createdAt, updatedAt, messages Json }`. `@@index([userId])` makes "list my sessions" fast.
- `client.ts` loads the root `.env`, creates a Postgres driver adapter (`PrismaPg`, which Prisma 7 requires) and exports `db`.
- The Prisma client is **generated** into `packages/database/generated/` by `prisma generate` (run automatically after `bun install`).

### Stage B — The server (≈60 min)

**B1. [server/src/index.ts](../packages/server/src/index.ts)**: how the API is assembled. Read top to bottom:
- [L13-L23](../packages/server/src/index.ts#L13-L23): Sentry middleware first, so it sees every request. The `integrations` filter drops Sentry's `VercelAI` integration, which locks the AI SDK's streams and breaks every chat.
- [L35-L60](../packages/server/src/index.ts#L35-L60): `app.onError`, the single place unhandled errors become JSON. `HTTPException` keeps its status; anything else becomes a 500 and is logged.
- [L62-L65](../packages/server/src/index.ts#L62-L65): **which routes need login**. `/sessions/*`, `/chat/*`, `/billing/checkout`, `/billing/portal`. (`/chat/*` also covers plain `/chat`.) `/auth/callback` and `/billing/success` stay public because a browser hits them.
- [L67-L73](../packages/server/src/index.ts#L67-L73): routes are **chained** and the result's type is exported as `AppType`. Chaining matters: it is how Hono's type for "all routes" is built, and the CLI depends on it.
- [L75](../packages/server/src/index.ts#L75): Bun serves the default export. `idleTimeout: 255` (the max) so long model replies aren't cut off.

**B2. [middleware/require-auth.ts](../packages/server/src/middleware/require-auth.ts) + [lib/auth.ts](../packages/server/src/lib/auth.ts)**
- `createMiddleware<AuthenticatedEnv>` declares that, after this middleware, `c.get("userId")` is a `string`. Every route typed with `AuthenticatedEnv` can then read it safely.
- `authenticateOAuthRequest` asks Clerk to verify the `Authorization: Bearer …` header **as an OAuth token** (`acceptsToken: "oauth_token"`), then returns the Clerk user id.

**B3. [middleware/require-credits-balance.ts](../packages/server/src/middleware/require-credits-balance.ts) + [lib/polar.ts](../packages/server/src/lib/polar.ts)**
- Before expensive work, ask Polar for the user's credit balance. `<= 0` → 402 "run /upgrade". Polar unreachable or misconfigured → 503, with the real cause logged.
- In `polar.ts`: one `createPolar(...)` client; `getAvailableCreditsBalance` reads the customer's meter, and a Polar 404 (customer doesn't exist yet) counts as balance 0. `ingestAiUsage` reports usage. `createCheckoutUrl` and `createCustomerPortalUrl` produce links for the browser.

**B4. [routes/sessions.ts](../packages/server/src/routes/sessions.ts)**: list, get and create sessions.
- Every query filters by `userId`: `findUnique({ where: { id, userId } })` means you can only load your own sessions. This is the ownership check.
- Creating a session only needs a `title`; the CLI uses the first 100 characters of your first message.
- `zValidator("json", schema, hook)`: Hono + Zod validate the body, and the hook turns failures into a clean 400.

**B5. [routes/chat.ts](../packages/server/src/routes/chat.ts)**: the heart of the server. Read slowly; [F1](#f1-sending-a-message-end-to-end) and [F2](#f2-the-tool-calling-loop) trace it step by step.
- [L41](../packages/server/src/routes/chat.ts#L41): request body `{ id, messages, mode, model }`.
- [L81-L95](../packages/server/src/routes/chat.ts#L81-L95): middleware order `requireCreditsBalance → submitValidator → handler`, then load the session with the ownership check.
- [L98-L126](../packages/server/src/routes/chat.ts#L98-L126): pick tools for the mode, pick the model, merge incoming messages into saved history **by id**, validate, convert to the model's format.
- [L130](../packages/server/src/routes/chat.ts#L130): `streamText(...)`, the actual LLM call.
- [L141-L207](../packages/server/src/routes/chat.ts#L141-L207): `toUIMessageStreamResponse(...)` turns the LLM stream into an HTTP streaming response, and its `onFinish` bills and saves.

**B6. [lib/models.ts](../packages/server/src/lib/models.ts) + [system-prompt.ts](../packages/server/src/system-prompt.ts)**
- `resolveChatModel(id)` → `{ model, provider, modelId, providerOptions }`. `anthropic(id)`, `openai(id)` and `google(id)` read their API key from env automatically.
- `*_PROVIDER_OPTIONS` turn on "thinking" per model; that's where the grey reasoning text in the UI comes from.
- `assertUnsupportedProvider(provider: never)` makes the `switch` exhaustive: add a provider to the union without a `case` and it stops compiling.
- `buildSystemPrompt({ mode })`: a different instruction block and tool list for PLAN vs BUILD.

**B7. [lib/credits.ts](../packages/server/src/lib/credits.ts)**: tokens → dollars → credits. 1 credit = $0.01, always rounded **up**, minimum 1 for any non-zero cost. Worked example in [F9](#f9-credits-and-billing).

**B8. [routes/billing.ts](../packages/server/src/routes/billing.ts) + [routes/auth.ts](../packages/server/src/routes/auth.ts)**
- Billing: return a Polar URL for the CLI to open in your browser.
- Auth: the OAuth redirect relay. Read it properly in Stage E.

### Stage C — The CLI foundation (≈45 min)

**C1. [cli/bin/devcode](../packages/cli/bin/devcode) and [cli/src/index.tsx](../packages/cli/src/index.tsx)**
- `bin/devcode` is the installed command: load `.env`, then import the app.
- `index.tsx`: a **memory router** (no browser URL bar) with three screens: `/` Home, `/sessions/new`, `/sessions/:id`. `createCliRenderer({ exitOnCtrlC: false })`: Ctrl+C is handled by the app itself (see C3).
- The pathless route with `errorElement` shows render crashes as text instead of crashing the terminal ([error-screen.tsx](../packages/cli/src/components/error-screen.tsx)).

**C2. [layouts/root-layout.tsx](../packages/cli/src/layouts/root-layout.tsx)**: the provider stack. **Order matters**: a provider can only use providers *outside* it. Dialog uses KeyboardLayer, so KeyboardLayer must wrap Dialog. Everything uses Theme, so Theme is outermost.

```
ThemeProvider → ToastProvider → KeyboardLayerProvider → DialogProvider → PromptConfigProvider → screens
```

**C3. [providers/keyboard-layer](../packages/cli/src/providers/keyboard-layer/index.tsx)**: read this **before** any component that handles keys. See [F10](#f10-keyboard-layers-who-gets-a-key-press).

**C4. The other providers**
- [dialog](../packages/cli/src/providers/dialog/index.tsx): one modal at a time; `open({ title, children, onClose })` / `close()`.
- [toast](../packages/cli/src/providers/toast/index.tsx): one notification at a time, auto-hides; `.unref()` so a pending timer never keeps the process alive.
- [theme](../packages/cli/src/providers/theme/index.tsx) + [theme.ts](../packages/cli/src/theme.ts): 32 color themes; your choice is saved to `~/.devcode/preferences.json`.
- [prompt-config](../packages/cli/src/providers/prompt-config/index.tsx): the current **mode** and **model** for the next message. Lives above the router, so it survives screen changes.

**C5. [lib/api-client.ts](../packages/cli/src/lib/api-client.ts), [lib/auth.ts](../packages/cli/src/lib/auth.ts), [lib/http-errors.ts](../packages/cli/src/lib/http-errors.ts)**
- `hc<AppType>(url, { fetch })`: a fully typed API client generated from the server's route types. The custom `fetch` adds the bearer token and deletes it on a 401.
- `auth.ts` stores the token in `~/.devcode/auth.json` with owner-only permissions (`0o600`).
- `getErrorMessage` pulls `{ error }` out of an error response, falling back to the status text.

### Stage D — The conversation flow in the CLI (≈90 min)

Read these in the order a message travels. [F1](#f1-sending-a-message-end-to-end) is the companion walkthrough.

**D1. [screens/home.tsx](../packages/cli/src/screens/home.tsx)**: the logo and the input. Submitting navigates to `/sessions/new` with `{ message, mode, model }` in router state.

**D2. [components/input-bar.tsx](../packages/cli/src/components/input-bar.tsx)**: the biggest UI file. It contains three features; read them separately:
- Typing and submitting: [L294-L299](../packages/cli/src/components/input-bar.tsx#L294-L299) (Enter submits, Shift+Enter adds a new line), [L381](../packages/cli/src/components/input-bar.tsx#L381) `handleSubmit`, and [L491-L509](../packages/cli/src/components/input-bar.tsx#L491-L509): one Enter handler that picks a command, picks a file, or sends.
- The slash-command menu: [command-menu/](../packages/cli/src/components/command-menu/), see [F11](#f11-slash-commands).
- The @file picker: [L59-L225](../packages/cli/src/components/input-bar.tsx#L59-L225), see [F12](#f12-file-mentions).
- Tab toggles the mode ([L511-L518](../packages/cli/src/components/input-bar.tsx#L511-L518)); Ctrl+C clears the input first ([L521-L534](../packages/cli/src/components/input-bar.tsx#L521-L534)).

**D3. [screens/new-session.tsx](../packages/cli/src/screens/new-session.tsx)**: a short-lived screen. It validates router state with Zod, `POST /sessions`, then **replaces** itself with `/sessions/:id`, passing `{ session, initialPrompt }`. `replace: true` means "back" never returns to this screen. `hasStartedRef` and `ignore` stop double creation and late updates.

**D4. [screens/session.tsx](../packages/cli/src/screens/session.tsx)**
- `Session` ([L119](../packages/cli/src/screens/session.tsx#L119)): uses the session passed in router state, or fetches it (when opened from `/sessions`).
- `SessionChat` ([L55](../packages/cli/src/screens/session.tsx#L55)): runs `useChat`, sends `initialPrompt` once ([L93-L103](../packages/cli/src/screens/session.tsx#L93-L103)), Esc interrupts ([L86-L91](../packages/cli/src/screens/session.tsx#L86-L91)), and renders the message list.
- `key={session.id}` on `SessionChat` gives a **fresh component per session**, so no chat state leaks between sessions.

**D5. [hooks/use-chat.ts](../packages/cli/src/hooks/use-chat.ts)**: the heart of the CLI. A thin wrapper around the AI SDK's `useChat`:
- [L35-L42](../packages/cli/src/hooks/use-chat.ts#L35-L42): the `Message` type (see [Part 4](#part-4--typescript-patterns-used-here)).
- [L56-L86](../packages/cli/src/hooks/use-chat.ts#L56-L86): the transport: URL, auth header, and the request body shape the server expects.
- [L92-L122](../packages/cli/src/hooks/use-chat.ts#L92-L122): `onToolCall`, which runs tools locally.
- [L123-L136](../packages/cli/src/hooks/use-chat.ts#L123-L136): `sendAutomaticallyWhen`, which continues the loop after tools and stops after 50 steps.
- [L139-L158](../packages/cli/src/hooks/use-chat.ts#L139-L158): the small API the screen uses: `messages`, `status`, `error`, `submit`, `abort`, `interrupt`.

**D6. [lib/local-tools.ts](../packages/cli/src/lib/local-tools.ts)**: what each tool actually does on your machine. See [F2](#f2-the-tool-calling-loop) for the safety rules.

**D7. [hooks/use-bash-approval.tsx](../packages/cli/src/hooks/use-bash-approval.tsx) + [dialogs/bash-approval-dialog.tsx](../packages/cli/src/components/dialogs/bash-approval-dialog.tsx)**: the "Run this command?" prompt. See [F3](#f3-bash-approval).

**D8. [components/messages/](../packages/cli/src/components/messages/)**: [user-message](../packages/cli/src/components/messages/user-message.tsx), [bot-message](../packages/cli/src/components/messages/bot-message.tsx), [error-message](../packages/cli/src/components/messages/error-message.tsx). See [F14](#f14-how-a-reply-is-drawn).

### Stage E — Accounts and money (≈30 min)

**E1. [lib/oauth.ts](../packages/cli/src/lib/oauth.ts)** together with **[server routes/auth.ts](../packages/server/src/routes/auth.ts)**: the login flow, [F7](#f7-login-oauth-with-pkce).

**E2. [lib/upgrade.ts](../packages/cli/src/lib/upgrade.ts)** and the `/login`, `/logout`, `/upgrade` and `/usage` entries in [commands.tsx](../packages/cli/src/components/command-menu/commands.tsx).

### Optional extras

[dialog-search-list.tsx](../packages/cli/src/components/dialog-search-list.tsx) (the reusable searchable list behind every picker), [dialogs/](../packages/cli/src/components/dialogs/) (agents, models, sessions, theme), [spinner.tsx](../packages/cli/src/components/spinner.tsx), [status-bar.tsx](../packages/cli/src/components/status-bar.tsx), [session-shell.tsx](../packages/cli/src/components/session-shell.tsx) (the scrolling chat layout with sticky-to-bottom scroll).

---

## Part 3 — Feature walkthroughs

Each walkthrough is a numbered trace. Open each link as you reach it.

### F1. Sending a message end to end

You type `What does src/index.ts do?` on the Home screen and press Enter.

| # | Where | What happens | Why |
|---|---|---|---|
| 1 | [input-bar.tsx L491](../packages/cli/src/components/input-bar.tsx#L491-L509) | Enter reaches `onSubmitRef`; no menu is open, so `handleSubmit` trims the text and calls `onSubmit(text)` | One Enter handler serves three meanings (command, file, send) |
| 2 | [home.tsx L12-L17](../packages/cli/src/screens/home.tsx#L12-L17) | `navigate("/sessions/new", { state: { message, mode, model } })` | Mode/model are captured *now*, so changing them later doesn't affect this message |
| 3 | [new-session.tsx L36-L58](../packages/cli/src/screens/new-session.tsx#L36-L58) | Shows your message with a spinner, `POST /sessions { title }` | You see your message immediately while the session is created |
| 4 | server [sessions.ts L80-L106](../packages/server/src/routes/sessions.ts#L80-L106) | `requireAuth` → `requireCreditsBalance` → validate → `db.session.create` → 201 | No credits, no new session |
| 5 | [new-session.tsx L55-L58](../packages/cli/src/screens/new-session.tsx#L55-L58) | `navigate('/sessions/<id>', { replace: true, state: { session, initialPrompt } })` | Passing the session avoids fetching it again |
| 6 | [session.tsx L93-L103](../packages/cli/src/screens/session.tsx#L93-L103) | `SessionChat` mounts and submits `initialPrompt` **once** (the ref guard) | The first message is sent from the session screen, so it streams in the normal UI |
| 7 | [use-chat.ts L143-L155](../packages/cli/src/hooks/use-chat.ts#L143-L155) | `chat.sendMessage({ text, metadata: { mode, model } })`; the SDK adds the user message to `messages`, `status` becomes `"submitted"` | Metadata travels with the message, so history remembers each message's mode/model |
| 8 | [use-chat.ts L63-L84](../packages/cli/src/hooks/use-chat.ts#L63-L84) | The transport builds the body `{ id: sessionId, messages: [lastMessage], mode, model }` | Only the newest message is sent; the server already has the rest |
| 9 | server [index.ts L62-L63](../packages/server/src/index.ts#L62-L63) → [chat.ts L81-L95](../packages/server/src/routes/chat.ts#L81-L95) | Auth → credit gate → body validation → load session (ownership check) | Cheap checks before the expensive LLM call |
| 10 | [chat.ts L98-L126](../packages/server/src/routes/chat.ts#L98-L126) | Choose tools for the mode; merge the new message into saved history; `validateUIMessages`; `convertToModelMessages` | UI messages (what you see) and model messages (what the LLM API wants) are different formats; the SDK converts |
| 11 | [chat.ts L130-L139](../packages/server/src/routes/chat.ts#L130-L139) | `streamText({ model, system, messages, tools, providerOptions })` | One call works for every provider |
| 12 | [chat.ts L141-L160](../packages/server/src/routes/chat.ts#L141-L160) | `toUIMessageStreamResponse` streams parts to the client; `messageMetadata` stamps `{mode, model}` at start and adds `durationMs`/`usage` at finish; `generateMessageId` gives the reply an id both sides share | The client gets reasoning, text and tool parts as they are generated |
| 13 | CLI, inside `@ai-sdk/react` | The SDK parses the stream and updates the assistant message part by part; `status` becomes `"streaming"` then `"ready"` | No hand-written stream parsing in this project |
| 14 | [session.tsx L111-L114](../packages/cli/src/screens/session.tsx#L111-L114) → [bot-message.tsx](../packages/cli/src/components/messages/bot-message.tsx) | Every update re-renders the list | That's the "typing" effect |
| 15 | [chat.ts L161-L203](../packages/server/src/routes/chat.ts#L161-L203) | When the stream finishes: bill the usage, then save `event.messages` (the full history) to `Session.messages` | Billing every finished request; saving only complete turns |

> **Streaming, in one sentence:** the server returns a `Response` whose body is a stream of Server-Sent Events. The AI SDK writes those events on the server (`toUIMessageStreamResponse`) and reads them on the client (`useChat`). Hono just passes the `Response` through.

### F2. The tool-calling loop

The model can't touch your disk; your CLI can. So a tool call is a round trip:

```
CLI (useChat)                          Server (/chat)                      LLM
─────────────                          ──────────────                      ───
sendMessage ──── POST [user] ────────▶ streamText(tools: schemas only) ───▶
                                                                    ◀──── "call readFile {path}"
            ◀─── stream: tool-readFile (state: input-available), finish
onToolCall → executeLocalTool("readFile")      (stream ended: the tool has no
          → addToolOutput(result)               execute, so the server can't
sendAutomaticallyWhen → true                    continue on its own)
            ── POST [user, assistant+output] ▶ merge by id → streamText ───▶
                                                                    ◀──── "It creates the renderer…"
            ◀─── stream: text …, finish        onFinish: bill + save whole turn
```

Step by step:

1. **The server offers tools without `execute`** ([schemas.ts](../packages/shared/src/schemas.ts), [chat.ts L98](../packages/server/src/routes/chat.ts#L98)). When the model calls one, `streamText` can't run it, so that request's stream ends with a tool part in state `input-available`.
2. **The CLI runs it** in `onToolCall` ([use-chat.ts L92-L122](../packages/cli/src/hooks/use-chat.ts#L92-L122)) → `executeLocalTool` ([local-tools.ts L70](../packages/cli/src/lib/local-tools.ts#L70)). The mode comes from the assistant message's metadata, which the server stamped.
3. **The result goes back into the message** with `addToolOutput` (`output`, or `state: "output-error"` + `errorText`). The model sees errors too and can react to them.
4. **`sendAutomaticallyWhen`** ([L123-L136](../packages/cli/src/hooks/use-chat.ts#L123-L136)) returns true once every tool call has a result, so the SDK sends again automatically. The body is `[user, assistant]` ([use-chat.ts L70-L74](../packages/cli/src/hooks/use-chat.ts#L70-L74)) because the assistant message now holds the outputs.
5. **The server merges by id** ([chat.ts L105-L120](../packages/server/src/routes/chat.ts#L105-L120)): the assistant message replaces nothing in the DB yet (it hasn't been saved), and the SDK *continues* that same assistant message.
6. **Loop limit.** Each round trip adds a `step-start` part; at 50, automatic sending stops. Typing "continue" resumes.
7. **Billing and saving.** Every finished request is billed with its own id (`chat-request:<uuid>`). History is saved only when no tool call is pending ([chat.ts L195](../packages/server/src/routes/chat.ts#L195)), because a saved conversation ending in an unanswered tool call can't be sent to a model again.

What each tool does ([local-tools.ts](../packages/cli/src/lib/local-tools.ts)):

| Tool | Mode | Does | Limits |
|---|---|---|---|
| `readFile` | both | reads a UTF-8 file | first 10,000 chars |
| `listDirectory` | both | lists a folder, folders first | hides dotfiles and `node_modules` |
| `glob` | both | `Bun.Glob` file search | 200 results |
| `grep` | both | runs system `grep -rnE` | 50 matches |
| `writeFile` | BUILD | creates/overwrites a file, making folders as needed | inside the project only |
| `editFile` | BUILD | replaces text that appears **exactly once** | fails if 0 or 2+ matches, so the model must be precise |
| `bash` | BUILD | runs `bash -c` in the project folder | asks you first ([F3](#f3-bash-approval)); 30 s default timeout; 20,000 chars of output |

**Path safety** ([L11-L62](../packages/cli/src/lib/local-tools.ts#L11-L62)): every file path goes through `resolveInsideCwd`. It rejects `../` escapes, and then resolves symlinks and checks the **real** location too, so a link inside the project can't point the model at `~/.ssh`. The limits on output exist to protect your **token bill**: everything a tool returns goes back to the model.

### F3. Bash approval

1. `onToolCall` sees `bash` and awaits `requestApproval(input)` ([use-chat.ts L99](../packages/cli/src/hooks/use-chat.ts#L99)).
2. [use-bash-approval.tsx](../packages/cli/src/hooks/use-bash-approval.tsx): if you chose "don't ask again this session", it returns true at once. Otherwise it opens a dialog and returns a promise that resolves when you decide.
3. **Requests are queued** ([L67-L74](../packages/cli/src/hooks/use-bash-approval.tsx#L67-L74)): the model can ask for several commands at once, but only one dialog fits on screen.
4. **Any way of closing counts as "No"**: Escape, a click outside, Ctrl+C, another dialog opening, or leaving the session. This works through the dialog's `onClose` ([dialog/index.tsx L41-L61](../packages/cli/src/providers/dialog/index.tsx#L41-L61)); without it the promise would wait forever.
5. A refusal becomes a tool error telling the model not to retry and to ask you instead ([use-chat.ts L25-L26](../packages/cli/src/hooks/use-chat.ts#L25-L26)).
6. If you leave the session, results are dropped ([use-chat.ts L48-L54](../packages/cli/src/hooks/use-chat.ts#L48-L54)), so a closed chat can't trigger a new request.

### F4. PLAN vs BUILD modes

Switch with **Tab** ([input-bar.tsx L511-L518](../packages/cli/src/components/input-bar.tsx#L511-L518)) or `/agents`. The mode colors the input border, spinner and status bar.

PLAN is enforced in **three independent layers**, so no single bug lets PLAN mode write files:

| Layer | Where | Effect |
|---|---|---|
| 1. Instructions | [system-prompt.ts](../packages/server/src/system-prompt.ts) | Tells the model it must not change anything |
| 2. Tools offered | [schemas.ts `getToolContracts`](../packages/shared/src/schemas.ts) | In PLAN the model is never *given* writeFile/editFile/bash |
| 3. Tool execution | [local-tools.ts L75-L80](../packages/cli/src/lib/local-tools.ts#L75-L80) | Even if a write tool were called, the CLI refuses it |

### F5. Models and provider options

1. Pick with `/models` ([models-dialog.tsx](../packages/cli/src/components/dialogs/models-dialog.tsx)) → `setModel` in [prompt-config](../packages/cli/src/providers/prompt-config/index.tsx). The default is `gpt-5.4-nano` ([models.ts L96](../packages/shared/src/models.ts#L96)).
2. The model id travels in the message metadata and the request body.
3. The server validates it (`isSupportedChatModel`) and resolves it in [lib/models.ts](../packages/server/src/lib/models.ts) to a provider object plus **provider options**: Anthropic `thinking.budgetTokens`, OpenAI reasoning summary, Gemini `thinkingConfig.includeThoughts`. Those options produce `reasoning` parts, which [bot-message.tsx L77](../packages/cli/src/components/messages/bot-message.tsx#L77) draws as dim italic text.

**To add a model:** add an entry (id, provider, pricing) to [shared/models.ts](../packages/shared/src/models.ts), and optionally a provider-options entry in [server/lib/models.ts](../packages/server/src/lib/models.ts). The types, the picker and the price calculation all follow automatically.

### F6. Sessions and saved history

| Action | CLI | Server |
|---|---|---|
| Create | [new-session.tsx](../packages/cli/src/screens/new-session.tsx) | `POST /sessions` (needs credits) |
| List | `/sessions` → [sessions-dialog.tsx](../packages/cli/src/components/dialogs/sessions-dialog.tsx) | `GET /sessions` → id, title, createdAt only |
| Open | [session.tsx L134-L167](../packages/cli/src/screens/session.tsx#L134-L167) | `GET /sessions/:id` → includes `messages` |
| Save | (automatic) | [chat.ts L197](../packages/server/src/routes/chat.ts#L197) after each complete turn |

- `session.messages` is exactly the AI SDK's `UIMessage[]`, so the CLI hands it straight to `useChat` as `initialMessages` ([session.tsx L66-L68](../packages/cli/src/screens/session.tsx#L66-L68)). No mapping layer.
- Message ids: the server generates the assistant reply's id (`generateMessageId`, [chat.ts L65](../packages/server/src/routes/chat.ts#L65)) and sends it to the client in the stream's first event, so the saved id and the on-screen id match. Sessions saved before this fix may contain assistant messages with the id `""`.
- `hc` + `InferResponseType` give the CLI the exact response type of each endpoint ([session.tsx L17-L20](../packages/cli/src/screens/session.tsx#L17-L20)).

### F7. Login (OAuth with PKCE)

Command: `/login` ([commands.tsx L78-L97](../packages/cli/src/components/command-menu/commands.tsx#L78-L97)) → `performLogin()` ([oauth.ts L40](../packages/cli/src/lib/oauth.ts#L40)).

```
CLI                          Browser                 Clerk                    Server /auth/callback
───                          ───────                 ─────                    ─────────────────────
make verifier + challenge
start temp server :<random port>
open /oauth/authorize?challenge,state={nonce,port} ─▶ you sign in
                                                      redirect ──────────────▶ read port from state
                                                                               302 → localhost:<port>/callback
temp server ◀──────────────── ?code&state ──────────────────────────────────────┘
check nonce
POST /oauth/token {code, verifier} ──────────────────▶ access_token
save ~/.devcode/auth.json, stop temp server
```

Why each piece exists:
- **PKCE** ([L48-L50](../packages/cli/src/lib/oauth.ts#L48-L50)): a CLI can't keep a client secret. Instead it sends a hash of a random `verifier` up front, and must show the original verifier to exchange the code. Someone who steals the code can't use it.
- **Random-port temporary server** ([L55](../packages/cli/src/lib/oauth.ts#L55)): `port: 0` lets the OS choose a free port, so the CLI receives the browser redirect without colliding with anything.
- **Server relay** ([routes/auth.ts](../packages/server/src/routes/auth.ts)): Clerk only redirects to *pre-registered* URLs, and the CLI's port changes every time. So Clerk redirects to the fixed `API_URL/auth/callback`, which forwards to the port written inside `state`.
- **Nonce in `state`** ([L84-L94](../packages/cli/src/lib/oauth.ts#L84-L94)): proves the callback answers *this* login attempt.
- **5-minute timeout** ([L159-L165](../packages/cli/src/lib/oauth.ts#L159-L165)): don't leave a server running forever.

`/logout` just deletes the token file.

### F8. How API requests are authenticated

- Normal requests go through `apiClient` ([api-client.ts](../packages/cli/src/lib/api-client.ts)), whose custom `fetch` adds `Authorization: Bearer <token>` and deletes the saved token on a 401.
- Chat requests go through the AI SDK transport, which adds the header with its own `headers()` callback ([use-chat.ts L59-L62](../packages/cli/src/hooks/use-chat.ts#L59-L62)). It reads the token on every request, so logging in mid-session works.
- The server verifies with Clerk ([lib/auth.ts](../packages/server/src/lib/auth.ts)) and stores `userId` in the request context ([require-auth.ts L18](../packages/server/src/middleware/require-auth.ts#L18)).
- **Typed API calls:** `hc<AppType>` turns the server's chained route definitions into client methods (`apiClient.sessions[":id"].$get({ param: { id } })`) with typed params, bodies and responses. Rename a route on the server and the CLI stops compiling.

### F9. Credits and billing

| Step | Where | What |
|---|---|---|
| Gate | [require-credits-balance.ts](../packages/server/src/middleware/require-credits-balance.ts) | Before `POST /sessions` and `POST /chat`: balance `<= 0` → 402 |
| Measure | [chat.ts L130-L139](../packages/server/src/routes/chat.ts#L130-L139) | `streamText`'s `onFinish` reports token usage |
| Price | [credits.ts](../packages/server/src/lib/credits.ts) | tokens × model price → USD → credits (round up) |
| Charge | [chat.ts L161-L193](../packages/server/src/routes/chat.ts#L161-L193) → [polar.ts `ingestAiUsage`](../packages/server/src/lib/polar.ts#L113) | Send a `devcode_usage` event with `{ credits }`; Polar's meter subtracts it from the balance |
| Buy | `/upgrade` → [upgrade.ts](../packages/cli/src/lib/upgrade.ts) → `POST /billing/checkout` | Opens a Polar checkout in your browser |
| Manage | `/usage` → `POST /billing/portal` | Opens Polar's customer portal |

Worked examples (1 credit = $0.01, always rounded up):
- `gpt-5.4-nano`, 20,000 input + 1,000 output tokens: (20,000 × 0.20 + 1,000 × 1.25) / 1,000,000 = **$0.00525** → 0.525 credits → **1 credit**.
- `claude-sonnet-4-6`, 50,000 input + 2,000 output: (50,000 × 3 + 2,000 × 15) / 1,000,000 = **$0.18** → **18 credits**.

Why the `external_id`: Polar ignores a second event with the same id, so a retried report can't charge twice. Each request has its own id because one assistant message can span several requests.

### F10. Keyboard layers (who gets a key press)

Every component can listen to the keyboard (`useKeyboard`), so the app needs a rule for *who* reacts. That rule is a **stack of layer names** ([keyboard-layer/index.tsx L28](../packages/cli/src/providers/keyboard-layer/index.tsx#L28)):

```
["base"]                       normal typing
["base", "command"]            slash menu open      (pushed by use-command-menu)
["base", "mention"]            @file picker open    (pushed by input-bar)
["base", ..., "dialog"]        a dialog is open     (pushed by DialogProvider)
```

- A listener only acts if its layer is on top: `if (!isTopLayer("dialog")) return;`. That's why arrows move the dialog's list, not the input, while a dialog is open.
- The textarea is focused only when the top layer is base, command or mention ([input-bar.tsx L638-L643](../packages/cli/src/components/input-bar.tsx#L638-L643)), so typing in a dialog doesn't leak into the chat input.
- **Ctrl+C** ([L72-L85](../packages/cli/src/providers/keyboard-layer/index.tsx#L72-L85)) walks the stack from the top, asking each layer's *responder* "do you want this?". Dialog → close it. Command/mention menu → close it. Base → clear the input if it has text. Nobody wants it → exit the app.

### F11. Slash commands

1. Typing `/` at the start of the input opens the menu ([use-command-menu.ts L38-L57](../packages/cli/src/components/command-menu/use-command-menu.ts#L38-L57)); a space closes it.
2. The text after `/` filters by name prefix ([filter-commands.ts](../packages/cli/src/components/command-menu/filter-commands.ts)).
3. Enter or a click runs `command.action(ctx)` ([input-bar.tsx L421-L443](../packages/cli/src/components/input-bar.tsx#L421-L443)). `ctx` (type in [types.ts](../packages/cli/src/components/command-menu/types.ts)) gives commands what they need (navigate, dialog, toast, mode/model setters, exit) without each command importing React hooks.
4. All commands live in one array: [commands.tsx](../packages/cli/src/components/command-menu/commands.tsx). **To add a command:** add an object there.

### F12. @file mentions

1. On every change or cursor move, `findActiveMention` ([input-bar.tsx L59](../packages/cli/src/components/input-bar.tsx#L59)) finds the `@word` under the cursor. It ignores e-mail-like text (`a@b`), because the character before `@` must not be a name character.
2. `getMentionCandidates` ([L107](../packages/cli/src/components/input-bar.tsx#L107)) lists matching files: folder part + name prefix, never outside the project, dotfiles only if you type `.`. If nothing matches directly, it searches subfolders (skipping `node_modules`) for up to 32 hits.
3. Choosing inserts `@path ` (or `@folder/` to keep drilling down).
4. **Note:** a mention is just text. The file's contents are *not* attached; the model sees the path and calls `readFile` itself.

### F13. Dialogs, toasts and themes

- **Dialogs** ([providers/dialog](../packages/cli/src/providers/dialog/index.tsx)) render once, above everything (`position="absolute"`, `zIndex={100}`). The content is any React node, so each dialog is just a component: [agents](../packages/cli/src/components/dialogs/agents-dialog.tsx), [models](../packages/cli/src/components/dialogs/models-dialog.tsx), [sessions](../packages/cli/src/components/dialogs/sessions-dialog.tsx), [theme](../packages/cli/src/components/dialogs/theme-dialog.tsx), [bash approval](../packages/cli/src/components/dialogs/bash-approval-dialog.tsx).
- **[DialogSearchList](../packages/cli/src/components/dialog-search-list.tsx)** is a generic `<T>` component (search box + scrolling list + arrows/Enter/mouse), reused by four dialogs.
- **Theme preview:** the theme dialog applies a theme while you move through the list (`onHighlight`), and puts back the original on unmount unless you confirmed ([theme-dialog.tsx L15-L21](../packages/cli/src/components/dialogs/theme-dialog.tsx#L15-L21)).
- **Toasts** show one message in the top-right corner for a few seconds.

### F14. How a reply is drawn

[bot-message.tsx](../packages/cli/src/components/messages/bot-message.tsx) receives the assistant message's `parts` and:
1. Groups consecutive parts of the same kind ([L44](../packages/cli/src/components/messages/bot-message.tsx#L44)), so ten tool calls in a row render as one block.
2. Draws by part type: `reasoning` → dim italics with a left border; tool parts (`tool-readFile`, `tool-bash`, …) → `Read file: src/index.ts …`, where the `…` shows until `state` is `output-available` or `output-error`; `text` → normal text.
3. Draws a footer: mode · model · duration (from metadata, formatted by `pretty-ms`).

`step-start` parts are not drawn; they only mark where each round trip began.

### F15. Errors and monitoring

| Where it fails | What the user sees | Code |
|---|---|---|
| Any server route throws | JSON `{ error }`, 500 logged to Sentry | [index.ts L35-L60](../packages/server/src/index.ts#L35-L60) |
| The LLM call fails mid-stream | the error text, shown under the chat | `onError` [chat.ts L204](../packages/server/src/routes/chat.ts#L204) → `useChat().error` → [session.tsx L114](../packages/cli/src/screens/session.tsx#L114) |
| A non-chat request fails | a red toast | `getErrorMessage` + `toast.show` (e.g. [new-session.tsx L59-L67](../packages/cli/src/screens/new-session.tsx#L59-L67)) |
| A React component crashes | "Something went wrong" screen | [error-screen.tsx](../packages/cli/src/components/error-screen.tsx) |

Sentry captures server errors, request traces and structured logs (`Sentry.logger.info/warn/error`).

### F16. Packaging the CLI as a command

- `"bin": { "devcode": "./bin/devcode" }` in [cli/package.json](../packages/cli/package.json) names the command.
- `bun run link:cli` (root) builds and `bun link`s it, so `devcode` works in any folder.
- The bin file loads `.env` from the repo root, so a linked install still finds the API URL and Clerk ids.

---

## Part 4 — TypeScript patterns used here

| Pattern | Example | Where | What it buys you |
|---|---|---|---|
| Derive types from data with `as const` + `typeof` | `type ToolContracts = typeof buildToolContracts` | [schemas.ts](../packages/shared/src/schemas.ts) | One source of truth; types can't drift |
| `as const satisfies T` | model list | [models.ts L87](../packages/shared/src/models.ts#L87) | Exact literal types **and** a shape check |
| Indexed access types | `(typeof SUPPORTED_CHAT_MODELS)[number]["id"]`, `Message["parts"][number]` | [models.ts L89-L90](../packages/shared/src/models.ts#L89-L90), [bot-message.tsx L8](../packages/cli/src/components/messages/bot-message.tsx#L8) | Pull a type out of another type |
| Const object instead of `enum` | `Mode` + `ModeType = (typeof Mode)[keyof typeof Mode]` | [schemas.ts](../packages/shared/src/schemas.ts) | Plain strings at runtime, a union at compile time |
| `Extract<Union, Shape>` | `Extract<SupportedChatModel, { provider: "openai" }>["id"]` | [server lib/models.ts](../packages/server/src/lib/models.ts) | "Only the OpenAI model ids" |
| Template literal types | `{ type: \`tool-${string}\` }` | [bot-message.tsx L9-L12](../packages/cli/src/components/messages/bot-message.tsx#L9-L12) | Match `tool-readFile`, `tool-bash`, … without listing them |
| Type predicates | `function isToolPart(p): p is ToolPart` | [bot-message.tsx L28](../packages/cli/src/components/messages/bot-message.tsx#L28) | Narrow a union inside an `if` |
| Mapped types | `{ [Name in keyof X]: { input: X[Name]["input"]; output: unknown } }` | [use-chat.ts L35-L40](../packages/cli/src/hooks/use-chat.ts#L35-L40) | Transform every key of a type |
| Generics from a library | `UIMessage<Metadata, DataParts, Tools>` | [use-chat.ts L42](../packages/cli/src/hooks/use-chat.ts#L42), [chat.ts](../packages/server/src/routes/chat.ts) | Typed message parts and metadata everywhere |
| Generic components | `DialogSearchList<T>` | [dialog-search-list.tsx](../packages/cli/src/components/dialog-search-list.tsx) | One list for themes, models, sessions… |
| Exhaustive switch with `never` | `assertUnsupportedProvider(provider: never)` | [server lib/models.ts L82](../packages/server/src/lib/models.ts#L82) | Compiler error if a case is missing |
| `satisfies` on a value | `{ ...message, metadata } satisfies DevcodeUIMessage` | [chat.ts](../packages/server/src/routes/chat.ts) | Check without widening |
| Zod as types + validation | `z.infer`, `.parse(unknown)` → typed value | [local-tools.ts](../packages/cli/src/lib/local-tools.ts), [new-session.tsx](../packages/cli/src/screens/new-session.tsx) | Untrusted data (model output, router state, request bodies) becomes typed safely |
| `z.custom<T>(check)` | request messages | [chat.ts L41-L57](../packages/server/src/routes/chat.ts#L41-L57) | A shallow check where a full schema is impractical |
| Typed middleware context | `createMiddleware<AuthenticatedEnv>` → `c.get("userId"): string` | [require-auth.ts](../packages/server/src/middleware/require-auth.ts) | Routes know what middleware guaranteed |
| Typed RPC | `hc<AppType>`, `InferResponseType<…, 200>` | [api-client.ts](../packages/cli/src/lib/api-client.ts), [session.tsx L17](../packages/cli/src/screens/session.tsx#L17) | Server routes become typed client methods |
| Escape hatch `as unknown as T` | DB JSON ↔ `UIMessage[]` | [chat.ts](../packages/server/src/routes/chat.ts), [session.tsx L67](../packages/cli/src/screens/session.tsx#L67) | Compiles, but **no checking happens**: these are trust boundaries |
| `noUncheckedIndexedAccess` | `messages[messages.length - 1]` is `T \| undefined` | everywhere | Forces you to handle "might be missing" |

React patterns worth recognising: **refs for "latest value" or "already done" flags** (`hasStartedRef`, `onSubmitRef`, `isMountedRef`), **`let ignore = false` in effects** to drop results after unmount, **context + `useX()` hooks that throw outside their provider**, and **`key={id}` to reset a component**.

---

## Part 5 — Reference

### HTTP API

| Method + path | Middleware | Body → Response |
|---|---|---|
| `GET /auth/callback` | none | Clerk redirect → 302 to `localhost:<port>/callback` |
| `GET /sessions` | auth | → `[{ id, title, createdAt }]` |
| `GET /sessions/:id` | auth | → full session incl. `messages` |
| `POST /sessions` | auth, credits | `{ title }` → session (201) |
| `POST /chat` | auth, credits | `{ id, messages, mode, model }` → UI message stream |
| `POST /billing/checkout` | auth | → `{ url }` |
| `POST /billing/portal` | auth | → `{ url }` |
| `GET /billing/success` | none | plain text "Done…" |
| `GET /debug-sentry` | none | throws on purpose (Sentry test) |

### Environment variables ([.env.example](../.env.example))

| Variable | Used by | For |
|---|---|---|
| `API_URL` | CLI | server address (default `http://localhost:3000`), OAuth redirect |
| `DATABASE_URL` | server (database pkg) | Postgres connection |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` | server | read automatically by the AI SDK providers |
| `SENTRY_DSN` | server | error reporting |
| `CLERK_FRONTEND_API`, `CLERK_OAUTH_CLIENT_ID` | CLI | login URLs |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | server | verifying tokens |
| `POLAR_ACCESS_TOKEN`, `POLAR_SERVER` | server | Polar API (`sandbox` or `production`) |
| `POLAR_PRODUCT_ID`, `POLAR_CREDITS_METER_ID` | server | what checkout sells; which meter is the credit balance |

`CLERK_OAUTH_CLIENT_SECRET` and `JWT_SECRET` appear in `.env.example` but nothing reads them.

### What a saved conversation looks like

`Session.messages`, simplified (real ids are random):

```json
[
  {
    "id": "Kz3…",
    "role": "user",
    "metadata": { "mode": "BUILD", "model": "gpt-5.4-nano" },
    "parts": [{ "type": "text", "text": "What does src/index.ts do?" }]
  },
  {
    "id": "msg-yqHUciZewmAcocB5",
    "role": "assistant",
    "metadata": { "mode": "BUILD", "model": "gpt-5.4-nano", "durationMs": 4210 },
    "parts": [
      { "type": "step-start" },
      { "type": "reasoning", "text": "I should read the file first." },
      {
        "type": "tool-readFile",
        "toolCallId": "call_1",
        "state": "output-available",
        "input": { "path": "src/index.ts" },
        "output": { "content": "import { createCliRenderer } …" }
      },
      { "type": "step-start" },
      { "type": "text", "text": "It creates the terminal renderer and a memory router…" }
    ]
  }
]
```

### Glossary

| Term | Meaning |
|---|---|
| **UIMessage** | AI SDK message for the app: `id`, `role`, `metadata`, `parts[]`. What's stored and drawn |
| **ModelMessage** | AI SDK message in the format LLM APIs accept. Made from UIMessages by `convertToModelMessages` |
| **Part** | One piece of a message: `text`, `reasoning`, `tool-<name>`, `step-start` |
| **Step** | One LLM call. A turn with tools has several steps, one per round trip |
| **Tool contract** | A tool's name, description and input schema, without the code that runs it |
| **Mode** | BUILD (can change files) or PLAN (read-only) |
| **Credit** | DevCode's billing unit, $0.01 of model cost |
| **Meter** | Polar's running counter of a customer's credits |
| **PKCE** | OAuth extension that lets apps without a secret log in safely |
| **Keyboard layer** | Named entry on the key-handling stack; only the top layer reacts |

---

## Part 6 — Known gaps and things to watch

Accurate as of this guide's writing. Useful as a to-do list.

**Behaviour**
- **Interrupted turns are lost.** History is saved only when a turn finishes ([chat.ts L161-L203](../packages/server/src/routes/chat.ts#L161-L203)), and an aborted stream returns early. Press Esc mid-answer and, after a reload, both your message and the partial reply are gone.
- **Esc may not stop the model on the server.** `streamText` isn't given `abortSignal: c.req.raw.signal`, so stopping the provider call relies on the stream being cancelled when the client disconnects. Passing the signal would make it explicit.
- **`writeFile` and `editFile` don't ask.** They can't leave the project, but they can overwrite files without confirmation.
- **`bash` isn't confined to the project.** Approval is the only protection.
- **The server trusts the history the client sends** for a message id (it replaces it during the merge). Low risk, since each user only reaches their own sessions.
- **A 401 on a chat request doesn't log you out.** Only `apiClient` clears the saved token; the chat transport uses its own fetch.
- **The credit gate checks, it doesn't reserve.** A request that starts with 1 credit left can cost more than 1.
- **Older sessions** may contain assistant messages with id `""` (saved before the message-id fix).
- **@mentions are text only**; file contents aren't attached.

**Configuration (as of the last check)**
- The Anthropic API key was rejected (401), and the Polar sandbox token was rejected (401 `invalid_token`).
- Google reports `gemini-2.5-flash` and `gemini-2.5-flash-lite` as unavailable to new users.
- Port 3000 can be taken by another process (it was a Remotion render), which breaks `/auth/callback`.
- The login callback server (`Bun.serve`, [oauth.ts L55](../packages/cli/src/lib/oauth.ts#L55)) listens on all network interfaces; `hostname: "127.0.0.1"` would limit it to this machine.
- Running `bunx tsc` inside `packages/server` downloads an old TypeScript and fails on `"module": "Preserve"`. Use the workspace's TypeScript (5.9.3) instead.

**Small things**
- `sessions.ts` logs `userId: "mock-user"` on a 404 ([L67-L70](../packages/server/src/routes/sessions.ts#L67-L70)).
- The sessions dialog shows only the time (`hh:mm a`), not the date.
- `StatusBar` and `Spinner` import `ModeType` without using it.

---

## Part 7 — Self-check

Try answering from memory, then confirm in the code.

1. Why can't the server run `readFile` itself? Where does it actually run? *(F2, local-tools.ts)*
2. What makes a tool "client-side" in the AI SDK? *(schemas.ts: no `execute`)*
3. A request arrives at `POST /chat`. List, in order, everything that runs before `streamText`. *(index.ts L62-L63, chat.ts L81-L126)*
4. Why does the CLI send only the last one or two messages instead of the whole conversation? *(use-chat.ts L63-L84)*
5. PLAN mode is protected in three places. Name them. *(F4)*
6. You press Ctrl+C while the `/models` dialog is open. What happens, and which code decides? *(F10)*
7. What would break if `hasSubmittedInitialPromptRef.current = true` were removed? *(session.tsx L93-L103)*
8. Why does login go through the server's `/auth/callback` instead of straight to the CLI? *(F7)*
9. A request uses 120,000 input and 4,000 output tokens on `gpt-5.4`. How many credits? *(F9; answer: (120,000 × 2.5 + 4,000 × 15) / 1e6 = $0.36 → 36 credits)*
10. Why is history saved only when no tool call is pending? *(chat.ts L195)*
11. Add a new slash command `/clear` that clears the screen. Which single file do you edit? *(commands.tsx)*
12. Where would you add a new model, and what updates automatically? *(F5)*

If you can answer these, you understand the whole project.
