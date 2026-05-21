# Nexus CLI Architecture

**Product:** Nexus CLI  
**Platform:** Nexus Weaver  
**Document Type:** Architecture Specification  
**Status:** Draft v1.0  
**Primary Constraint:** The entire application source code MUST be written in TypeScript.  
**Primary UX Goal:** Codex-style terminal coding agent experience, invoked with `nexus`, using familiar TUI, slash commands, sandbox/approval concepts and non-interactive execution mode.  
**Primary Technical Goal:** TypeScript-based local-first agentic development runtime with Agentic SDLC Plane, Learning Plane, secure Tool Bus, model routing, event sourcing and enterprise-ready policy controls.

---

## 1. Executive Architecture Summary

Nexus CLI is a terminal-native, local-first, TypeScript-based agentic software development runtime.

The user-facing experience must be intentionally familiar:

```bash
nexus
nexus "Analyze this repository"
nexus exec "Fix the failing tests"
nexus exec --json "Review this diff"
```

Inside that familiar CLI/TUI interface, Nexus runs a deeper runtime:

```text
User Prompt
  ↓
Session Runtime
  ↓
Agent Orchestrator
  ↓
Agentic SDLC Plane
  ↓
Context Engine
  ↓
Model Router
  ↓
Tool Bus
  ↓
Security Runtime
  ↓
Event Store
  ↓
Learning Plane
```

Nexus is not a simple LLM wrapper. It is a TypeScript application composed of isolated packages that coordinate:

- terminal UI
- CLI command parsing
- session management
- model provider routing
- context building
- planning
- patch generation
- shell/file/git/test tools
- approval workflow
- sandbox policy
- event logging
- memory learning
- subagents
- MCP tools
- skills
- hooks
- non-interactive automation

The central architectural principle:

> **Every meaningful operation must flow through typed contracts, policy checks, event recording and observable state transitions.**

---

## 2. Hard Architecture Constraints

### 2.1 TypeScript-Only Application Source

All Nexus-owned source code MUST be TypeScript.

Allowed:

- TypeScript
- TSX for TUI components if a React/Ink-style TUI is used
- JSON/TOML/YAML/Markdown configuration and data files
- Generated TypeScript types
- Shell scripts only for packaging/dev convenience, not runtime business logic

Not allowed in core application source:

- Rust
- Go
- C++
- C
- Python
- Native Node.js addons as mandatory runtime dependencies
- Hidden native modules in core packages
- Direct binary-only runtime logic owned by Nexus

### 2.2 External System Tools Are Allowed Through Adapters

Nexus may invoke external tools through controlled TypeScript adapters:

- `git`
- shell commands
- package managers such as `npm`, `pnpm`, `yarn`
- test runners
- Docker/Podman or other container tools
- OS sandbox utilities if available
- MCP server processes

However, all invocation logic, policy decisions, parsing, event handling and orchestration must remain TypeScript.

### 2.3 OS-Level Sandbox Reality

A fully reliable OS-level sandbox cannot be reimplemented purely in TypeScript. Nexus must therefore use this rule:

> TypeScript owns policy and orchestration. The operating system or an external sandbox/container primitive enforces hard isolation.

If a requested security profile requires OS-enforced isolation and no suitable adapter is available, Nexus must fail closed.

```text
Required sandbox unavailable → deny action → emit event → explain to user
```

### 2.4 No Direct Tool Execution From Model Output

The model must never directly execute tools. Model output is only a proposal.

All tool execution must pass through:

```text
Model Proposal
  ↓
Tool Request Parser
  ↓
Tool Registry
  ↓
Risk Classifier
  ↓
Policy Engine
  ↓
Approval Engine
  ↓
Sandbox Adapter
  ↓
Tool Executor
  ↓
Event Store
```

### 2.5 Event-Sourced Runtime

Nexus runtime state should be reconstructable from events.

Every major operation must produce events:

- session created
- prompt received
- model called
- plan updated
- tool requested
- approval requested
- approval granted/denied
- file read
- file changed
- shell command started
- shell command completed
- sandbox violation
- verification result
- review finding
- memory candidate generated
- memory written
- error occurred

---

## 3. Top-Level Architecture

```text
┌───────────────────────────────────────────────────────────────┐
│                         Nexus CLI                             │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  CLI Entrypoint                                               │
│    ├─ nexus                                                   │
│    ├─ nexus exec                                              │
│    ├─ nexus resume                                            │
│    ├─ nexus fork                                              │
│    ├─ nexus mcp                                               │
│    ├─ nexus sandbox                                           │
│    └─ nexus completion                                        │
│                                                               │
│  Interactive TUI                                              │
│    ├─ Transcript View                                         │
│    ├─ Composer                                                │
│    ├─ Slash Command Palette                                   │
│    ├─ Approval Cards                                          │
│    ├─ Diff Viewer                                             │
│    ├─ Process Panel                                           │
│    ├─ Memory Panel                                            │
│    └─ Status Line                                             │
│                                                               │
│  Runtime Core                                                 │
│    ├─ Session Runtime                                         │
│    ├─ Agent Orchestrator                                      │
│    ├─ Agentic SDLC Plane                                      │
│    ├─ Learning Plane                                          │
│    ├─ Context Engine                                          │
│    ├─ Model Router                                            │
│    ├─ Tool Bus                                                │
│    ├─ Security Runtime                                        │
│    ├─ Config System                                           │
│    ├─ Storage Layer                                           │
│    └─ Event Bus                                               │
│                                                               │
│  Extension Layer                                              │
│    ├─ MCP Client                                              │
│    ├─ Skills                                                  │
│    ├─ Plugins                                                 │
│    └─ Hooks                                                   │
│                                                               │
│  Provider Layer                                               │
│    ├─ OpenAI Provider Adapter                                 │
│    ├─ Anthropic Provider Adapter                              │
│    ├─ Gemini Provider Adapter                                 │
│    ├─ Bedrock Provider Adapter                                │
│    ├─ Azure Provider Adapter                                  │
│    └─ Local Model Provider Adapter                            │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Architectural Style

Nexus should use a layered, event-driven, package-isolated architecture.

### 4.1 Layering Rule

Dependencies flow inward.

```text
apps/*
  ↓
features/*
  ↓
core/*
  ↓
shared/*
```

Higher-level packages can depend on lower-level packages. Lower-level packages must not import application UI, provider implementations or concrete platform adapters.

### 4.2 Dependency Direction

Allowed:

```text
CLI App → TUI
CLI App → Runtime
Runtime → Tool Bus
Runtime → Context Engine
Runtime → Model Router Interface
Model Router → Provider Interface
Provider Adapter → Shared Types
```

Not allowed:

```text
Core Runtime → TUI
Core Runtime → Specific Provider Implementation
Tool Bus → TUI
Security Runtime → Model Provider
Context Engine → CLI Parser
Learning Plane → TUI Component
```

### 4.3 Core Rule

The core runtime must be UI-agnostic.

The same runtime must support:

```bash
nexus
```

and:

```bash
nexus exec --json "..."
```

without duplicating logic.

---

## 5. Repository Layout

Recommended monorepo layout:

```text
nexus-weaver/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  tsconfig.json
  turbo.json
  README.md
  AGENTS.md

  apps/
    cli/
      src/
        main.ts
        bootstrap.ts
        command-router.ts
        interactive-entry.ts
        exec-entry.ts
      package.json

  packages/
    shared/
      src/
        types/
        errors/
        constants/
        result.ts
        ids.ts
      package.json

    events/
      src/
        event-bus.ts
        event-types.ts
        event-writer.ts
        event-reader.ts
        event-replay.ts
      package.json

    config/
      src/
        config-loader.ts
        config-schema.ts
        config-resolver.ts
        profile-resolver.ts
        toml-codec.ts
      package.json

    storage/
      src/
        filesystem-store.ts
        session-store.ts
        memory-store.ts
        auth-store.ts
        artifact-store.ts
      package.json

    tui/
      src/
        app.tsx
        components/
          transcript-view.tsx
          composer.tsx
          slash-palette.tsx
          approval-card.tsx
          diff-viewer.tsx
          status-line.tsx
          process-panel.tsx
          memory-panel.tsx
        state/
          tui-store.ts
          event-reducer.ts
        keymap/
      package.json

    runtime/
      src/
        nexus-runtime.ts
        session-runtime.ts
        turn-runner.ts
        conversation-manager.ts
        resume-manager.ts
        fork-manager.ts
      package.json

    agent/
      src/
        orchestrator.ts
        planner.ts
        executor.ts
        verifier.ts
        reviewer.ts
        critic.ts
        rollback-manager.ts
        subagent-manager.ts
      package.json

    sdlc/
      src/
        sdlc-state-machine.ts
        stages/
          discover.ts
          plan.ts
          implement.ts
          verify.ts
          review.ts
          ship.ts
          learn.ts
        goal-manager.ts
        definition-of-done.ts
      package.json

    learning/
      src/
        learning-plane.ts
        memory-distiller.ts
        candidate-generator.ts
        candidate-reviewer.ts
        workflow-learner.ts
        eval-generator.ts
        scorecard.ts
      package.json

    context/
      src/
        context-engine.ts
        context-compiler.ts
        repo-map.ts
        symbol-index.ts
        file-mentions.ts
        agents-md-loader.ts
        memory-injector.ts
        compaction.ts
        token-budget.ts
      package.json

    model-router/
      src/
        model-router.ts
        model-provider.ts
        model-call.ts
        model-events.ts
        tool-call-parser.ts
        prompt-compiler.ts
      package.json

    providers/
      openai/
        src/
          openai-provider.ts
        package.json

      anthropic/
        src/
          anthropic-provider.ts
        package.json

      gemini/
        src/
          gemini-provider.ts
        package.json

      bedrock/
        src/
          bedrock-provider.ts
        package.json

      local/
        src/
          local-provider.ts
        package.json

    tool-bus/
      src/
        tool-bus.ts
        tool-registry.ts
        tool-types.ts
        file-tool.ts
        patch-tool.ts
        shell-tool.ts
        git-tool.ts
        test-tool.ts
        search-tool.ts
        web-tool.ts
        tool-output-summarizer.ts
      package.json

    security/
      src/
        security-runtime.ts
        policy-engine.ts
        approval-engine.ts
        risk-classifier.ts
        command-risk.ts
        path-guard.ts
        secrets-scanner.ts
        prompt-injection-detector.ts
        network-policy.ts
        protected-paths.ts
      package.json

    sandbox/
      src/
        sandbox-adapter.ts
        sandbox-manager.ts
        adapters/
          no-sandbox.ts
          readonly-sandbox.ts
          workspace-sandbox.ts
          container-sandbox.ts
          external-sandbox.ts
      package.json

    mcp/
      src/
        mcp-client.ts
        mcp-server-registry.ts
        mcp-tool-adapter.ts
        mcp-policy.ts
      package.json

    skills/
      src/
        skill-loader.ts
        skill-registry.ts
        skill-manifest.ts
        skill-context.ts
      package.json

    hooks/
      src/
        hook-registry.ts
        hook-runner.ts
        hook-policy.ts
      package.json

    plugins/
      src/
        plugin-registry.ts
        plugin-loader.ts
        plugin-manifest.ts
        plugin-policy.ts
      package.json

    evals/
      src/
        eval-runner.ts
        fixture-loader.ts
        golden-events.ts
        model-replay.ts
      package.json

    test-utils/
      src/
        fake-model-provider.ts
        fake-tool.ts
        fixture-repo.ts
        pty-test-harness.ts
      package.json
```

---

## 6. Package Responsibility Matrix

| Package | Responsibility |
|---|---|
| `apps/cli` | Process entrypoint, CLI args, bootstrap, mode selection |
| `packages/tui` | Interactive terminal UI only |
| `packages/runtime` | Session lifecycle, turns, resume, fork, orchestration entry |
| `packages/agent` | Planner, executor, verifier, reviewer, subagents |
| `packages/sdlc` | Agentic SDLC state machine |
| `packages/learning` | Memory candidate generation, workflow learning, eval generation |
| `packages/context` | Repo map, file context, AGENTS.md, memory injection, compaction |
| `packages/model-router` | Provider-neutral model calls and routing |
| `packages/providers/*` | Concrete model API adapters |
| `packages/tool-bus` | File, shell, git, test, MCP tool execution abstraction |
| `packages/security` | Policy, approval, risk scoring, secrets, path protection |
| `packages/sandbox` | Sandbox adapter orchestration |
| `packages/mcp` | MCP server/tool integration |
| `packages/skills` | Skill loading and progressive disclosure |
| `packages/hooks` | Lifecycle hook execution |
| `packages/events` | Event types, event bus, JSONL read/write, replay |
| `packages/storage` | Local filesystem storage for config, sessions, memory, artifacts |
| `packages/config` | Config loading, merging, validation |
| `packages/shared` | Shared types, errors, constants, utility primitives |
| `packages/evals` | Automated eval and regression harness |

---

## 7. Runtime Modes

Nexus must support two primary runtime modes.

---

### 7.1 Interactive Mode

Command:

```bash
nexus
```

or:

```bash
nexus "Review this repository"
```

Flow:

```text
CLI Parser
  ↓
Config Resolver
  ↓
Project Trust Check
  ↓
Session Runtime
  ↓
TUI Mount
  ↓
Event Bus Subscription
  ↓
User Prompt
  ↓
Agent Orchestrator
  ↓
Tool Bus / Model Router / Security Runtime
  ↓
TUI Updates From Events
```

Interactive mode owns the user interface only. It must not own core logic.

---

### 7.2 Non-Interactive Mode

Command:

```bash
nexus exec "Fix the failing test"
```

or:

```bash
nexus exec --json "Analyze this diff"
```

Flow:

```text
CLI Parser
  ↓
Config Resolver
  ↓
Session Runtime
  ↓
Agent Orchestrator
  ↓
Event Bus
  ↓
JSONL Writer
  ↓
Final Artifact Writer
  ↓
Exit Code Resolver
```

Non-interactive mode must:

- not mount TUI
- not block waiting for manual approval unless explicitly allowed
- produce deterministic exit codes
- optionally stream JSONL events
- write patch/report artifacts when requested
- support CI/CD usage

---

## 8. CLI Command Architecture

### 8.1 Command Entrypoint

The CLI entrypoint should be small.

```ts
#!/usr/bin/env node

import { main } from "./main";

main(process.argv).catch((error) => {
  console.error(error);
  process.exit(1);
});
```

### 8.2 Command Routing

```text
argv
  ↓
parseCommand()
  ↓
resolveConfig()
  ↓
createRuntime()
  ↓
dispatch command
```

Supported command families:

```bash
nexus
nexus exec
nexus resume
nexus fork
nexus login
nexus logout
nexus mcp
nexus mcp-server
nexus completion
nexus features
nexus sandbox
nexus update
nexus apply
nexus cloud
nexus app-server
```

### 8.3 Command Router Interface

```ts
export interface CliCommand {
  name: string;
  description: string;
  run(ctx: CliCommandContext): Promise<CliCommandResult>;
}

export interface CliCommandContext {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface CliCommandResult {
  exitCode: number;
}
```

### 8.4 CLI Flags

Global flags:

```bash
--model
-m

--profile
-p

--cd
-C

--sandbox

--ask-for-approval

--config
-c

--image

--oss

--search

--no-alt-screen
```

The architecture must map global flags into a typed runtime config object. Raw CLI flags must not be passed around the system as untyped strings.

---

## 9. TUI Architecture

### 9.1 TUI Design Principle

The TUI must be a projection of runtime events.

The TUI does not decide:

- whether a tool may run
- whether a command is safe
- which files can be edited
- which model should be used
- whether memory can be written

The TUI only:

- renders state
- captures user input
- sends user intents
- displays approval prompts
- displays diffs and results

### 9.2 TUI State Flow

```text
Runtime Events
  ↓
TUI Event Reducer
  ↓
TUI Store
  ↓
Terminal Components
```

### 9.3 TUI Component Tree

```text
<NexusTuiApp>
  <TranscriptView />
  <ToolCallList />
  <ApprovalOverlay />
  <DiffViewer />
  <ProcessPanel />
  <MemoryPanel />
  <SlashCommandPalette />
  <Composer />
  <StatusLine />
</NexusTuiApp>
```

### 9.4 TUI Store

```ts
export interface TuiState {
  sessionId: string;
  transcript: TranscriptItem[];
  activeToolCalls: ToolCallView[];
  pendingApprovals: ApprovalRequestView[];
  currentDiff?: DiffView;
  slashPalette: SlashPaletteState;
  composer: ComposerState;
  statusLine: StatusLineState;
  memoryPanel: MemoryPanelState;
}
```

### 9.5 Status Line Fields

The status line must support:

```text
model
sandbox
approval
cwd
git_branch
tokens
sdlc_stage
learning_mode
session_id
background_processes
```

Example:

```text
model:gpt-5.5 | sandbox:workspace-write | approval:on-request | branch:feature/auth | SDLC:Verify | learning:suggest
```

### 9.6 Slash Command Palette

Slash commands are parsed as typed intents.

```ts
export type SlashCommandIntent =
  | { type: "model.select" }
  | { type: "permissions.open" }
  | { type: "status.show" }
  | { type: "plan.start"; prompt?: string }
  | { type: "goal.set"; goal?: string }
  | { type: "diff.show" }
  | { type: "review.start" }
  | { type: "compact.start" }
  | { type: "memories.open" }
  | { type: "agent.open" }
  | { type: "mcp.open" }
  | { type: "hooks.open" }
  | { type: "process.list" }
  | { type: "process.stop"; processId?: string }
  | { type: "session.quit" };
```

The slash command layer must not execute business logic directly. It sends intents to the runtime.

---

## 10. Session Runtime

### 10.1 Responsibility

The Session Runtime manages:

- session creation
- turn lifecycle
- conversation history
- event stream
- resume
- fork
- side threads
- artifact storage
- current working directory
- active config snapshot

### 10.2 Session Lifecycle

```text
created
  ↓
initialized
  ↓
active
  ↓
waiting_for_input
  ↓
running_turn
  ↓
waiting_for_approval
  ↓
completed
  ↓
archived
```

### 10.3 Session Object

```ts
export interface NexusSession {
  id: SessionId;
  createdAt: string;
  cwd: string;
  repoRoot?: string;
  mode: "interactive" | "non-interactive";
  config: ResolvedConfig;
  state: SessionState;
  activeThreadId: ThreadId;
  eventLogPath: string;
}
```

### 10.4 Turn Lifecycle

```text
User Input
  ↓
Turn Started
  ↓
Context Compiled
  ↓
Model Called
  ↓
Plan Updated
  ↓
Tool Requests Parsed
  ↓
Tool Calls Executed
  ↓
Verification / Review
  ↓
Learning Candidates Generated
  ↓
Turn Completed
```

### 10.5 Runtime Entrypoint

```ts
export interface NexusRuntime {
  startSession(input: StartSessionInput): Promise<NexusSession>;
  runTurn(sessionId: SessionId, input: UserTurnInput): Promise<TurnResult>;
  resumeSession(selector: ResumeSelector): Promise<NexusSession>;
  forkSession(sessionId: SessionId, input: ForkInput): Promise<NexusSession>;
  approve(requestId: ApprovalRequestId, decision: ApprovalDecision): Promise<void>;
  stop(sessionId: SessionId): Promise<void>;
}
```

---

## 11. Event System

### 11.1 Principle

Events are the source of truth for observability, non-interactive output, audit and replay.

### 11.2 Event Bus

```ts
export interface EventBus {
  publish(event: NexusEvent): Promise<void>;
  subscribe(handler: EventHandler): Unsubscribe;
}
```

### 11.3 Event Shape

```ts
export interface NexusEventBase {
  id: EventId;
  sessionId: SessionId;
  threadId?: ThreadId;
  parentEventId?: EventId;
  timestamp: string;
  type: string;
  severity?: "debug" | "info" | "warning" | "error";
}
```

### 11.4 Event Categories

```ts
export type NexusEvent =
  | SessionEvent
  | UserInputEvent
  | AssistantMessageEvent
  | ModelEvent
  | PlanEvent
  | SdlcEvent
  | ToolEvent
  | ApprovalEvent
  | SandboxEvent
  | FileEvent
  | ShellEvent
  | VerificationEvent
  | ReviewEvent
  | LearningEvent
  | MemoryEvent
  | ErrorEvent;
```

### 11.5 JSONL Output

Each event is written as one JSON object per line.

Example:

```json
{"id":"evt_1","type":"session.started","sessionId":"nx_123","timestamp":"2026-05-20T10:00:00Z"}
{"id":"evt_2","type":"sdlc.stage.started","stage":"discover","sessionId":"nx_123","timestamp":"2026-05-20T10:00:01Z"}
{"id":"evt_3","type":"tool.requested","tool":"shell.run","risk":"medium","sessionId":"nx_123","timestamp":"2026-05-20T10:00:02Z"}
{"id":"evt_4","type":"tool.completed","tool":"shell.run","exitCode":0,"sessionId":"nx_123","timestamp":"2026-05-20T10:00:10Z"}
```

### 11.6 Event Store

The event store writes to:

```text
.nexus/runs/<session-id>/events.jsonl
```

For user-level non-repo sessions:

```text
~/.nexus/runs/<session-id>/events.jsonl
```

---

## 12. Agent Orchestrator

### 12.1 Responsibility

The Agent Orchestrator coordinates:

- user intent
- context building
- SDLC stage
- model calls
- tool calls
- verification
- review
- learning
- final response

### 12.2 Orchestrator Flow

```text
runTurn()
  ↓
classifyIntent()
  ↓
updateGoal()
  ↓
advanceSdlc()
  ↓
compileContext()
  ↓
callModel()
  ↓
parseToolRequests()
  ↓
executeToolsSafely()
  ↓
observeResults()
  ↓
maybeVerify()
  ↓
maybeReview()
  ↓
generateLearningCandidates()
  ↓
produceFinalAnswer()
```

### 12.3 Orchestrator Interface

```ts
export interface AgentOrchestrator {
  runTurn(input: OrchestratorTurnInput): Promise<OrchestratorTurnResult>;
}

export interface OrchestratorTurnInput {
  session: NexusSession;
  thread: ConversationThread;
  userInput: UserTurnInput;
  runtimeContext: RuntimeContext;
}

export interface OrchestratorTurnResult {
  finalMessage?: string;
  filesChanged: string[];
  commandsRun: CommandSummary[];
  verification?: VerificationSummary;
  review?: ReviewSummary;
  learningCandidates: LearningCandidate[];
}
```

### 12.4 Planner

Planner produces a structured plan.

```ts
export interface Plan {
  id: PlanId;
  goal: string;
  steps: PlanStep[];
  risks: PlanRisk[];
  requiredPermissions: PermissionRequirement[];
  definitionOfDone: DefinitionOfDoneItem[];
}
```

### 12.5 Executor

Executor applies approved actions.

```ts
export interface Executor {
  executePlan(plan: Plan, ctx: ExecutionContext): Promise<ExecutionResult>;
}
```

### 12.6 Verifier

Verifier decides and runs verification actions.

```ts
export interface Verifier {
  proposeVerification(ctx: VerificationContext): Promise<VerificationPlan>;
  runVerification(plan: VerificationPlan): Promise<VerificationResult>;
}
```

### 12.7 Reviewer

Reviewer inspects changes.

```ts
export interface Reviewer {
  reviewWorkingTree(ctx: ReviewContext): Promise<ReviewResult>;
}
```

---

## 13. Agentic SDLC Plane

### 13.1 Purpose

The Agentic SDLC Plane maps agent work into software development lifecycle stages.

```text
Discover → Plan → Implement → Verify → Review → Ship → Learn
```

It is not a separate CLI UX. It is a runtime layer behind familiar commands.

### 13.2 Stage State Machine

```ts
export type SdlcStage =
  | "discover"
  | "plan"
  | "implement"
  | "verify"
  | "review"
  | "ship"
  | "learn";

export interface SdlcState {
  currentStage: SdlcStage;
  goal?: Goal;
  definitionOfDone: DefinitionOfDoneItem[];
  completedStages: SdlcStage[];
  blockedReason?: string;
}
```

### 13.3 Stage Transition Rules

```text
discover → plan
plan → implement
implement → verify
verify → review
review → ship
ship → learn
learn → completed
```

Allowed backtracking:

```text
verify → implement
review → implement
ship → review
learn → plan
```

### 13.4 Slash Command Mapping

| Slash Command | SDLC Action |
|---|---|
| `/goal` | Create/update goal and definition of done |
| `/plan` | Enter or update plan stage |
| `/diff` | Inspect implement stage output |
| `/review` | Enter review stage |
| `/compact` | Preserve context and distill learning facts |
| `/memories` | Inspect learning stage output |
| `/status` | Display SDLC state |
| `/agent` | Assign stage-specific subagents |

### 13.5 SDLC Stage Contracts

Each stage must implement:

```ts
export interface SdlcStageHandler {
  stage: SdlcStage;
  enter(ctx: SdlcContext): Promise<void>;
  run(ctx: SdlcContext): Promise<SdlcStageResult>;
  exit(ctx: SdlcContext): Promise<void>;
}
```

### 13.6 Discover Stage

Responsibilities:

- detect repo root
- detect package manager
- detect test commands
- read `AGENTS.md`
- inspect git status
- build initial repo map
- identify relevant files
- detect protected/risky areas

### 13.7 Plan Stage

Responsibilities:

- produce structured plan
- estimate affected files
- estimate required permissions
- identify verification commands
- define done criteria
- request user confirmation when needed

### 13.8 Implement Stage

Responsibilities:

- apply file reads
- produce patch
- write files only through Tool Bus
- log all changes
- maintain rollback checkpoint
- respect sandbox and approval

### 13.9 Verify Stage

Responsibilities:

- propose verification commands
- run tests/lint/typecheck where allowed
- parse outputs
- summarize failures
- loop back to implement if needed

### 13.10 Review Stage

Responsibilities:

- review current diff
- check missing tests
- check security issues
- check unnecessary changes
- check style/convention mismatch
- produce severity-ranked findings

### 13.11 Ship Stage

Responsibilities:

- commit message suggestion
- PR title
- PR description
- changelog
- release note
- risk summary
- rollback note

### 13.12 Learn Stage

Responsibilities:

- generate learning candidates
- attach source events
- calculate confidence
- classify scope
- request user approval
- write accepted memory

---

## 14. Learning Plane

### 14.1 Purpose

The Learning Plane extracts controlled, scoped, reviewable knowledge from sessions.

It learns:

- user preferences
- project conventions
- test commands
- common failure patterns
- workflow sequences
- model/tool effectiveness
- repo-specific known risks

It does not train models by default.

### 14.2 Learning Modes

```ts
export type LearningMode = "off" | "observe" | "suggest" | "active";
```

| Mode | Behavior |
|---|---|
| `off` | No learning |
| `observe` | Events collected, no memory writes |
| `suggest` | Candidate generated, user approval required |
| `active` | Low-risk candidate may be written if policy allows |

Default:

```text
suggest
```

### 14.3 Memory Scopes

```ts
export type MemoryScope =
  | "user"
  | "project"
  | "team"
  | "workflow"
  | "eval"
  | "session";
```

### 14.4 Learning Candidate

```ts
export interface LearningCandidate {
  id: LearningCandidateId;
  scope: MemoryScope;
  type:
    | "preference"
    | "project_convention"
    | "test_command"
    | "workflow"
    | "known_failure"
    | "security_rule"
    | "eval_case";
  text: string;
  confidence: number;
  sourceEventIds: EventId[];
  sensitive: boolean;
  requiresApproval: boolean;
  proposedStoragePath?: string;
}
```

### 14.5 Memory Object

```ts
export interface MemoryRecord {
  id: MemoryId;
  scope: MemoryScope;
  text: string;
  createdAt: string;
  updatedAt: string;
  sourceEventIds: EventId[];
  confidence: number;
  tags: string[];
  redacted: boolean;
}
```

### 14.6 Learning Flow

```text
Turn Completed
  ↓
Collect Events
  ↓
Extract Candidate Facts
  ↓
Run Secrets Scanner
  ↓
Classify Scope
  ↓
Score Confidence
  ↓
Policy Check
  ↓
Show Candidate
  ↓
User Accept/Edit/Reject
  ↓
Write Memory
  ↓
Emit Memory Event
```

### 14.7 Storage

User memory:

```text
~/.nexus/memories/user.md
~/.nexus/memories/preferences.json
```

Project memory:

```text
.nexus/learning/project-memory.md
.nexus/learning/workflows.json
.nexus/learning/known-failures.json
.nexus/learning/test-map.json
.nexus/learning/evals/
```

### 14.8 Memory Injection

The Context Engine must inject memory only after:

- scope match
- policy approval
- token budget check
- recency/relevance ranking
- secrets scan

Memory must not override:

1. system safety rules
2. enterprise policy
3. project policy
4. explicit current user instruction

---

## 15. Context Engine

### 15.1 Purpose

The Context Engine builds the model input.

It composes:

- user prompt
- system/runtime instructions
- enterprise policy
- project config
- AGENTS.md
- active SDLC goal
- plan
- relevant files
- git diff
- tool outputs
- memory
- skills
- MCP tool descriptions
- conversation summary

### 15.2 Context Compiler

```ts
export interface ContextCompiler {
  compile(input: ContextCompileInput): Promise<CompiledContext>;
}

export interface CompiledContext {
  messages: ModelMessage[];
  toolDefinitions: ModelToolDefinition[];
  metadata: {
    tokenEstimate: number;
    includedFiles: string[];
    includedMemories: MemoryId[];
    includedSkills: string[];
  };
}
```

### 15.3 Context Priority

Priority order:

```text
1. Runtime safety instructions
2. Enterprise policy
3. Security policy
4. Project config
5. AGENTS.md
6. Current user instruction
7. Active SDLC goal
8. Active plan
9. Relevant files/diffs
10. Verified memory
11. Tool outputs
12. Conversation summary
13. Optional skills
```

### 15.4 Repo Map

The repo map should capture:

- root
- package manager
- workspace structure
- source directories
- test directories
- config files
- package manifests
- dependency hints
- likely entrypoints
- recent git changes
- ignored paths

```ts
export interface RepoMap {
  repoRoot: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  workspaces: WorkspaceInfo[];
  importantFiles: RepoFileSummary[];
  testCommands: TestCommandCandidate[];
  sourceDirectories: string[];
  riskAreas: RiskArea[];
}
```

### 15.5 File Mentions

Supported patterns:

```text
@file
@folder/
@symbol
@diff
@tests
```

File mentions resolve through:

```text
mention string
  ↓
path resolver
  ↓
path guard
  ↓
file reader
  ↓
context budget check
  ↓
context inclusion
```

### 15.6 Compaction

Compaction must produce:

- conversation summary
- preserved user goal
- current plan
- open questions
- changed files
- verification state
- memory candidates
- lost context warning if needed

```ts
export interface CompactionResult {
  summary: string;
  preservedFacts: string[];
  openTasks: string[];
  changedFiles: string[];
  learningCandidates: LearningCandidate[];
}
```

---

## 16. Model Router

### 16.1 Purpose

The Model Router decouples Nexus from specific model providers.

It decides:

- which provider to call
- which model to use
- whether streaming is enabled
- which tool schema format to use
- how to normalize responses
- how to handle provider errors
- how to record token/cost metadata

### 16.2 Provider Interface

```ts
export interface ModelProvider {
  id: string;
  displayName: string;
  capabilities: ModelProviderCapabilities;

  call(input: ModelCallInput): Promise<ModelCallResult>;
  stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent>;
}
```

### 16.3 Capabilities

```ts
export interface ModelProviderCapabilities {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsImages: boolean;
  supportsReasoningSummaries: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}
```

### 16.4 Model Router Interface

```ts
export interface ModelRouter {
  selectModel(input: ModelSelectionInput): Promise<SelectedModel>;
  call(input: RoutedModelCallInput): Promise<ModelCallResult>;
  stream(input: RoutedModelCallInput): AsyncIterable<ModelStreamEvent>;
}
```

### 16.5 Task-Based Model Selection

| Task | Model Class |
|---|---|
| Planning | frontier reasoning/coding model |
| Implementation | coding-capable model |
| Review | high-precision reviewer model |
| Security review | high-capability model |
| Summarization | fast/cheap model |
| Memory distillation | fast/cheap model |
| Subagent exploration | fast/cheap model |
| Final response | active conversation model |

### 16.6 Provider Packages

Concrete providers must be isolated:

```text
packages/providers/openai
packages/providers/anthropic
packages/providers/gemini
packages/providers/bedrock
packages/providers/local
```

Core packages must depend only on `ModelProvider` interface.

---

## 17. Tool Bus

### 17.1 Purpose

The Tool Bus is the only layer allowed to execute tools.

Tools include:

- file read
- file write
- patch apply
- shell command
- git
- test runner
- search
- MCP tool
- skill tool
- plugin tool
- hook tool

### 17.2 Tool Lifecycle

```text
requested
  ↓
validated
  ↓
risk_scored
  ↓
policy_checked
  ↓
approval_requested
  ↓
sandbox_prepared
  ↓
executed
  ↓
observed
  ↓
summarized
  ↓
logged
```

### 17.3 Tool Interface

```ts
export interface NexusTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: unknown;

  classifyRisk(input: TInput, ctx: ToolContext): Promise<ToolRisk>;
  prepare(input: TInput, ctx: ToolContext): Promise<ToolPreparation>;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
  summarize(output: TOutput, ctx: ToolContext): Promise<ToolSummary>;
}
```

### 17.4 Tool Request

```ts
export interface ToolRequest {
  id: ToolCallId;
  toolName: string;
  input: unknown;
  source: "model" | "user" | "hook" | "sdlc" | "system";
  reason?: string;
}
```

### 17.5 Tool Result

```ts
export interface ToolResult {
  id: ToolCallId;
  toolName: string;
  status: "success" | "failed" | "denied" | "cancelled";
  output?: unknown;
  error?: ToolError;
  summary?: string;
  events: EventId[];
}
```

### 17.6 File Tool Rules

All file operations must go through File Tool.

The File Tool must:

- canonicalize paths
- block protected paths
- block path traversal
- handle symlinks safely
- enforce workspace boundaries
- emit read/write events
- produce diff before write when possible

### 17.7 Patch Tool Rules

Patch Tool must:

- apply unified patches
- validate target paths
- create rollback checkpoint
- emit file change events
- reject patches touching protected paths unless approved
- support dry-run

### 17.8 Shell Tool Rules

Shell Tool must:

- parse command
- classify risk
- filter environment
- set working directory
- respect sandbox
- stream stdout/stderr events
- enforce timeout
- enforce output size limit
- redact secrets
- record exit code

### 17.9 Git Tool Rules

Git Tool must:

- expose status/diff/log helpers
- avoid destructive commands by default
- require approval for reset/clean/rebase/force-push-like operations
- emit git events
- support rollback metadata

### 17.10 Test Tool Rules

Test Tool must:

- detect test commands
- run selected command under sandbox
- parse result
- summarize failures
- feed verification stage

---

## 18. Security Runtime

### 18.1 Purpose

The Security Runtime enforces safety before tools run.

It contains:

- policy engine
- approval engine
- path guard
- command risk classifier
- secrets scanner
- prompt injection detector
- network policy
- protected path registry
- sandbox manager integration

### 18.2 Security Pipeline

```text
Tool Request
  ↓
Input Validation
  ↓
Path Guard
  ↓
Risk Classifier
  ↓
Secrets/Injection Check
  ↓
Policy Engine
  ↓
Approval Engine
  ↓
Sandbox Manager
  ↓
Execute or Deny
```

### 18.3 Policy Engine

```ts
export interface PolicyEngine {
  evaluate(input: PolicyEvaluationInput): Promise<PolicyDecision>;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "needs_approval";
  reason: string;
  requiredApproval?: ApprovalRequirement;
  effectiveSandbox?: SandboxMode;
}
```

### 18.4 Approval Engine

```ts
export interface ApprovalEngine {
  requestApproval(input: ApprovalRequestInput): Promise<ApprovalDecision>;
}
```

Approval decisions:

```ts
export type ApprovalDecision =
  | { type: "approved"; scope: ApprovalScope }
  | { type: "denied"; reason?: string }
  | { type: "cancelled" };
```

Approval scopes:

```ts
export type ApprovalScope =
  | "once"
  | "session"
  | "project"
  | "profile"
  | "organization";
```

### 18.5 Sandbox Modes

```ts
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";
```

### 18.6 Approval Policies

```ts
export type ApprovalPolicy =
  | "always"
  | "on-request"
  | "on-failure"
  | "never";
```

### 18.7 Protected Paths

Default protected paths:

```text
.env
.env.*
.ssh/
.aws/
.gcp/
.azure/
.git/
node_modules/
private keys
credential files
system directories
```

### 18.8 Command Risk Levels

```ts
export type RiskLevel = "low" | "medium" | "high" | "critical";
```

High-risk examples:

```text
rm -rf
curl | bash
wget | sh
unknown binary execution
credential file access
ssh key access
destructive git operations
production deploy commands
system package installation
network exfiltration
```

### 18.9 Secrets Scanner

Secrets Scanner must run on:

- tool output
- memory candidates
- final answer snippets
- event logs
- file diffs
- shell output

Potential findings:

```ts
export interface SecretFinding {
  type: "api_key" | "token" | "private_key" | "password" | "connection_string" | "unknown";
  severity: "low" | "medium" | "high" | "critical";
  redactedValue: string;
  location?: string;
}
```

### 18.10 Prompt Injection Detector

Prompt injection detection must inspect:

- README files
- issue text
- tool output
- web content
- MCP results
- generated files
- comments inside code when used as instruction-like content

It should label suspicious content but must not silently obey it.

---

## 19. Sandbox Architecture

### 19.1 Principle

Nexus is TypeScript-only, but sandbox enforcement may require external OS/container primitives.

Sandbox must be abstracted:

```ts
export interface SandboxAdapter {
  id: string;
  supports(mode: SandboxMode, platform: NodeJS.Platform): boolean;
  prepare(input: SandboxPrepareInput): Promise<SandboxContext>;
  run(command: SandboxCommand, ctx: SandboxContext): Promise<SandboxRunResult>;
  cleanup(ctx: SandboxContext): Promise<void>;
}
```

### 19.2 Sandbox Manager

```ts
export interface SandboxManager {
  resolve(mode: SandboxMode, ctx: RuntimeContext): Promise<SandboxAdapter>;
  run(input: SandboxedRunInput): Promise<SandboxedRunResult>;
}
```

### 19.3 Sandbox Adapter Types

```text
NoSandboxAdapter
  Used only for explicitly unsafe/dev profiles.

ReadOnlySandboxAdapter
  Allows read-only filesystem access where possible.

WorkspaceSandboxAdapter
  Allows write inside workspace only.

ContainerSandboxAdapter
  Uses Docker/Podman or compatible external runner if configured.

ExternalSandboxAdapter
  Uses platform-specific tools if available.
```

### 19.4 Fail-Closed Rule

If a profile requires hard sandboxing:

```text
sandbox required + no adapter available = deny
```

Nexus must not silently downgrade to unsafe execution.

### 19.5 Environment Filtering

Shell and tool execution must receive a sanitized environment.

Default behavior:

- remove secrets unless explicitly needed
- remove cloud credentials unless approved
- remove unnecessary auth tokens
- preserve minimal PATH
- preserve package manager variables only when safe

---

## 20. Configuration Architecture

### 20.1 Config Sources

Config precedence:

```text
1. CLI flags / --config
2. selected profile
3. .nexus/config.toml
4. ~/.nexus/config.toml
5. /etc/nexus/config.toml
6. built-in defaults
```

### 20.2 Config Resolver

```ts
export interface ConfigResolver {
  resolve(input: ConfigResolveInput): Promise<ResolvedConfig>;
}
```

### 20.3 Config Schema

```ts
export interface ResolvedConfig {
  model: string;
  modelProvider: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  features: FeatureFlags;
  learning: LearningConfig;
  sdlc: SdlcConfig;
  security: SecurityConfig;
  tui: TuiConfig;
  providers: ProviderConfigMap;
}
```

### 20.4 Example Config

```toml
model = "gpt-5.5"
model_provider = "openai"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[features]
agentic_sdlc = true
learning_plane = true
subagents = true
mcp = true
skills = true
hooks = true
plugins = false

[learning]
mode = "suggest"
redact_secrets = true
require_user_confirmation = true
generate_evals = true

[sdlc]
require_plan_for_large_changes = true
require_verification = true
require_review_for_security_sensitive_changes = true

[security]
network_default = "off"
secrets_scanning = true
prompt_injection_detection = true
protected_paths = [".env", ".env.*", ".ssh", ".git"]

[tui.status_line]
items = [
  "model",
  "sandbox",
  "approval",
  "git_branch",
  "tokens",
  "sdlc_stage",
  "learning_mode"
]
```

### 20.5 Profiles

```toml
[profiles.strict]
sandbox_mode = "read-only"
approval_policy = "always"

[profiles.dev]
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[profiles.ci]
sandbox_mode = "workspace-write"
approval_policy = "never"

[profiles.danger]
sandbox_mode = "danger-full-access"
approval_policy = "never"
```

Danger profiles must require explicit user confirmation during setup.

---

## 21. Storage Architecture

### 21.1 Storage Principle

Nexus should use filesystem-first storage for MVP.

Avoid mandatory native database dependencies.

### 21.2 User Storage

```text
~/.nexus/
  config.toml
  providers.toml
  auth.json
  memories/
    user.md
    preferences.json
  logs/
  cache/
  runs/
```

### 21.3 Project Storage

```text
.nexus/
  config.toml
  learning/
    project-memory.md
    workflows.json
    known-failures.json
    test-map.json
    command-map.json
    evals/
  runs/
    <session-id>/
      events.jsonl
      manifest.json
      diff.patch
      verification.json
      review.json
      learning-candidates.json
  cache/
```

### 21.4 Auth Storage

Auth must support:

- encrypted local file using Node.js crypto
- environment variable credentials
- optional external keychain adapter later
- provider-specific tokens

Auth records must not be included in memory, logs or model context.

### 21.5 Session Manifest

```ts
export interface SessionManifest {
  sessionId: SessionId;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  repoRoot?: string;
  branch?: string;
  mode: "interactive" | "non-interactive";
  model: string;
  provider: string;
  sandboxMode: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  filesChanged: string[];
  commandsRun: CommandSummary[];
  verificationStatus?: "passed" | "failed" | "skipped";
  reviewStatus?: "passed" | "warnings" | "failed" | "skipped";
}
```

---

## 22. AGENTS.md and Project Rules

### 22.1 Principle

`AGENTS.md` is a first-class project instruction file.

Nexus must read:

```text
AGENTS.md
```

from:

- repository root
- relevant subdirectories, if supported
- user-level config if configured

### 22.2 Rule Hierarchy

Instruction priority:

```text
1. System/runtime safety rules
2. Enterprise policy
3. Security policy
4. Project config
5. AGENTS.md
6. User prompt
7. Memory
8. Tool output
```

Memory cannot override rules.

Tool output cannot override rules.

### 22.3 AGENTS.md Loader

```ts
export interface AgentsMdLoader {
  load(input: AgentsMdLoadInput): Promise<AgentsMdDocument[]>;
}
```

---

## 23. MCP Architecture

### 23.1 Purpose

MCP tools extend Nexus with external capabilities.

### 23.2 MCP Flow

```text
MCP Config
  ↓
MCP Server Registry
  ↓
Server Process / Remote Connection
  ↓
Tool Manifest
  ↓
Policy Check
  ↓
Tool Bus Adapter
  ↓
Tool Call
  ↓
Event Log
```

### 23.3 MCP Tool Adapter

```ts
export interface McpToolAdapter extends NexusTool {
  serverId: string;
  mcpToolName: string;
}
```

### 23.4 MCP Security

MCP must support:

- allowlist
- per-server permission
- per-tool permission
- version pinning
- environment filtering
- audit logging
- network policy
- local/remote distinction

---

## 24. Skills Architecture

### 24.1 Purpose

Skills provide task-specific instructions, examples and tool preferences.

Examples:

```text
code-review
security-audit
release-notes
test-generation
migration-review
dependency-upgrade
frontend-accessibility
```

### 24.2 Progressive Disclosure

Skills should not be fully injected into every prompt.

Flow:

```text
User Task
  ↓
Skill Matcher
  ↓
Skill Summary Injected
  ↓
Full Skill Loaded Only If Needed
```

### 24.3 Skill Manifest

```ts
export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  files: string[];
  requiredTools?: string[];
  permissions?: PermissionRequirement[];
}
```

---

## 25. Hooks Architecture

### 25.1 Purpose

Hooks let users or teams run controlled automation around lifecycle events.

### 25.2 Hook Points

```text
before_session_start
after_session_start
before_plan
after_plan
before_tool_call
after_tool_call
before_patch_apply
after_patch_apply
before_verify
after_verify
before_review
after_review
before_memory_write
after_memory_write
before_session_end
after_session_end
```

### 25.3 Hook Execution

Hooks are tools and must pass through policy.

```text
Hook Trigger
  ↓
Hook Registry
  ↓
Policy Check
  ↓
Approval If Needed
  ↓
Sandboxed Execution
  ↓
Event Log
```

### 25.4 Hook Manifest

```ts
export interface HookDefinition {
  id: string;
  event: HookPoint;
  command?: string;
  script?: string;
  enabled: boolean;
  requiredPermissions: PermissionRequirement[];
}
```

---

## 26. Plugins Architecture

### 26.1 Plugin Strategy

Plugins are P1/P2, not MVP-critical.

A plugin can extend:

- slash commands
- tools
- skills
- context providers
- model providers
- TUI panels
- hooks

### 26.2 Plugin Safety

Plugins must require:

- manifest
- version pinning
- allowlist
- policy declaration
- permission declaration
- optional signature verification

### 26.3 Plugin Manifest

```ts
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: PermissionRequirement[];
  contributes: {
    tools?: string[];
    slashCommands?: string[];
    skills?: string[];
    contextProviders?: string[];
    tuiPanels?: string[];
  };
}
```

---

## 27. Subagent Architecture

### 27.1 Purpose

Subagents perform isolated tasks without polluting the main context.

Examples:

- Explorer Agent
- Architect Agent
- Coder Agent
- Test Agent
- Reviewer Agent
- Security Agent
- Docs Agent
- Release Agent
- Learning Agent

### 27.2 Subagent Model

```ts
export interface Subagent {
  id: SubagentId;
  name: string;
  role: SubagentRole;
  threadId: ThreadId;
  model?: string;
  permissionProfile: string;
  state: "idle" | "running" | "completed" | "failed";
}
```

### 27.3 Subagent Flow

```text
Main Thread
  ↓
Create Subagent Task
  ↓
Compile Isolated Context
  ↓
Run Subagent
  ↓
Collect Events
  ↓
Summarize Result
  ↓
Return Summary To Main Thread
```

### 27.4 Subagent Isolation

Each subagent must have:

- separate thread
- separate context budget
- separate tool permission profile
- separate event stream namespace
- summary-only return by default

### 27.5 `/agent` Command

`/agent` opens the subagent manager.

It should show:

```text
Main Thread
Architect Agent
Implementation Agent
Test Agent
Security Review Agent
Docs Agent
Learning Agent
```

---

## 28. Non-Interactive Architecture

### 28.1 Purpose

`nexus exec` runs Nexus without TUI.

### 28.2 Flow

```text
nexus exec
  ↓
parse args
  ↓
resolve config
  ↓
create session
  ↓
run turn
  ↓
stream JSONL events
  ↓
write artifacts
  ↓
resolve exit code
```

### 28.3 JSONL Events

When `--json` is provided, every event is written to stdout as JSONL.

Human final answer should go to configured output file or stderr unless explicitly requested.

### 28.4 Exit Code Resolver

```ts
export interface ExitCodeResolver {
  resolve(result: NonInteractiveResult): number;
}
```

Exit codes:

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General failure |
| 2 | Approval required but unavailable |
| 3 | Sandbox violation |
| 4 | Model/provider error |
| 5 | Tool execution error |
| 6 | Verification failed |
| 7 | Invalid config |
| 8 | Authentication error |

### 28.5 Non-Interactive Approval

If approval is needed and no interactive approval channel exists:

```text
emit approval.required
exit 2
```

Unless policy explicitly allows auto-denial or auto-approval.

---

## 29. Diff, Patch and Rollback Architecture

### 29.1 Principle

Every code mutation must be recoverable.

### 29.2 Patch Flow

```text
Proposed Change
  ↓
Create Diff
  ↓
Policy Check
  ↓
Approval
  ↓
Checkpoint
  ↓
Apply Patch
  ↓
Verify
  ↓
Commit/Keep/Rollback
```

### 29.3 Checkpoint

Checkpoint should store:

- file path
- pre-change hash
- pre-change content for modified files
- timestamp
- tool call id
- session id

```ts
export interface FileCheckpoint {
  id: CheckpointId;
  sessionId: SessionId;
  filePath: string;
  beforeHash: string;
  beforeContent?: string;
  createdAt: string;
}
```

### 29.4 Rollback Manager

```ts
export interface RollbackManager {
  createCheckpoint(paths: string[]): Promise<CheckpointId>;
  rollback(checkpointId: CheckpointId): Promise<RollbackResult>;
}
```

---

## 30. Verification Architecture

### 30.1 Verification Sources

Nexus can verify using:

- test command
- lint command
- typecheck command
- build command
- static analysis
- custom project hooks
- user-provided command

### 30.2 Verification Plan

```ts
export interface VerificationPlan {
  commands: VerificationCommand[];
  required: boolean;
  reason: string;
}
```

### 30.3 Verification Result

```ts
export interface VerificationResult {
  status: "passed" | "failed" | "skipped";
  commands: CommandVerificationResult[];
  summary: string;
}
```

### 30.4 Failure Handling

If verification fails:

```text
summarize failure
  ↓
identify likely cause
  ↓
loop to implement if safe
  ↓
otherwise ask user
```

---

## 31. Review Architecture

### 31.1 Review Inputs

Review uses:

- current diff
- changed files
- AGENTS.md
- project config
- memory
- verification result
- user goal
- known risks

### 31.2 Review Output

```ts
export interface ReviewFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  file?: string;
  line?: number;
  recommendation?: string;
}
```

### 31.3 Review Result

```ts
export interface ReviewResult {
  status: "passed" | "warnings" | "failed";
  findings: ReviewFinding[];
  summary: string;
}
```

---

## 32. Release and Ship Architecture

### 32.1 Ship Outputs

Ship stage can generate:

- commit message
- PR title
- PR description
- changelog
- release notes
- risk summary
- rollback instructions
- test summary

### 32.2 Ship Artifact

```ts
export interface ShipArtifact {
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;
  changelog?: string;
  riskSummary?: string;
  rollbackNote?: string;
  testSummary?: string;
}
```

---

## 33. Error Handling Architecture

### 33.1 Result Type

Core packages should prefer explicit result types for domain operations.

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

### 33.2 Error Categories

```ts
export type NexusErrorCategory =
  | "config"
  | "auth"
  | "model"
  | "tool"
  | "sandbox"
  | "approval"
  | "security"
  | "storage"
  | "tui"
  | "network"
  | "unknown";
```

### 33.3 Error Event

```ts
export interface ErrorEvent extends NexusEventBase {
  type: "error";
  category: NexusErrorCategory;
  message: string;
  cause?: string;
  recoverable: boolean;
}
```

### 33.4 User-Facing Error Rule

Errors must be:

- clear
- actionable
- non-leaky
- redacted
- associated with event id when possible

---

## 34. Build Architecture

### 34.1 Package Manager

Recommended:

```text
pnpm workspaces
```

### 34.2 TypeScript Config

Use strict TypeScript.

Recommended rules:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "declaration": true,
    "sourceMap": false
  }
}
```

### 34.3 Build Outputs

Each package should emit:

```text
dist/
  index.js
  index.d.ts
```

The CLI package should expose:

```json
{
  "bin": {
    "nexus": "./dist/main.js"
  }
}
```

### 34.4 Source Map Policy

Release builds must not accidentally publish source maps unless explicitly intended.

Release CI must verify:

- npm package contents
- no secrets
- no accidental `.map` files
- no local config
- no credentials
- no test fixtures containing secrets
- no private workspace paths

### 34.5 Release Package Whitelist

Each package should use explicit `files`.

Example:

```json
{
  "files": [
    "dist",
    "README.md",
    "LICENSE",
    "package.json"
  ]
}
```

---

## 35. Testing Architecture

### 35.1 Test Types

| Test Type | Purpose |
|---|---|
| Unit tests | Package-level logic |
| Contract tests | Provider/tool/config contracts |
| Integration tests | Runtime + tool bus + storage |
| TUI tests | Keyboard/input/render behavior |
| Sandbox tests | Permission and isolation behavior |
| E2E tests | Real fixture repo workflows |
| Golden event tests | Event stream stability |
| Eval tests | Agent task quality |
| Security tests | Path guard, secrets, command risk |

### 35.2 Fake Model Provider

Tests must not require live model calls by default.

Use fake provider:

```ts
export class FakeModelProvider implements ModelProvider {
  id = "fake";
  displayName = "Fake Model";
  capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: false
  };

  async call(input: ModelCallInput): Promise<ModelCallResult> {
    return makeDeterministicResult(input);
  }

  async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield* makeDeterministicStream(input);
  }
}
```

### 35.3 Fixture Repositories

Testing should include fixture repos:

```text
fixtures/
  node-basic/
  pnpm-monorepo/
  nextjs-app/
  express-api/
  typescript-library/
  failing-tests/
  protected-paths/
  prompt-injection/
  secrets/
```

### 35.4 Golden Event Tests

For critical flows, assert event sequences.

Example:

```text
session.started
sdlc.stage.started:discover
context.compiled
model.call.started
plan.updated
tool.requested
approval.requested
approval.granted
tool.completed
verification.completed
learning.candidate.created
turn.completed
```

---

## 36. Eval Architecture

### 36.1 Purpose

Evals measure the runtime, not just the model.

Eval dimensions:

- task completion
- diff minimality
- test pass rate
- unnecessary file changes
- sandbox compliance
- approval correctness
- memory candidate quality
- event correctness
- latency
- cost
- rollback success

### 36.2 Eval Case

```ts
export interface EvalCase {
  id: string;
  name: string;
  fixtureRepo: string;
  prompt: string;
  expectedFilesChanged?: string[];
  forbiddenFilesChanged?: string[];
  expectedCommands?: string[];
  successCriteria: EvalSuccessCriteria;
}
```

### 36.3 Eval Result

```ts
export interface EvalResult {
  caseId: string;
  status: "passed" | "failed" | "inconclusive";
  score: number;
  filesChanged: string[];
  commandsRun: string[];
  verificationStatus: string;
  notes: string[];
}
```

---

## 37. Observability Architecture

### 37.1 Local Observability

Nexus must provide:

```bash
nexus exec --json
```

and local files:

```text
.nexus/runs/<session-id>/events.jsonl
.nexus/runs/<session-id>/manifest.json
.nexus/runs/<session-id>/verification.json
.nexus/runs/<session-id>/review.json
```

### 37.2 Runtime Metrics

Collect locally:

- model latency
- tool latency
- command duration
- token estimates
- output size
- approval wait time
- sandbox denial count
- verification pass/fail
- memory candidate acceptance

### 37.3 Enterprise Observability

Future enterprise mode may export:

- audit logs
- policy decisions
- model usage
- MCP tool usage
- approval history
- high-risk command attempts

Export must be policy-controlled.

---

## 38. Privacy Architecture

### 38.1 Default Privacy

Default:

```text
local-first
no training by default
no content telemetry by default
local memory
local event logs
redacted secrets
```

### 38.2 Telemetry Classes

```text
operational metrics
product analytics
content telemetry
crash reports
enterprise audit
```

Content telemetry must be off by default.

### 38.3 Redaction Points

Redaction must happen before:

- memory write
- event persistence
- final answer display if needed
- model context injection
- telemetry export
- review artifact generation

---

## 39. Authentication Architecture

### 39.1 Auth Sources

Supported:

- environment variables
- encrypted local auth file
- provider login flow
- enterprise-managed credentials
- future OS keychain adapter

### 39.2 Auth Store

```ts
export interface AuthStore {
  get(providerId: string): Promise<AuthRecord | undefined>;
  set(providerId: string, record: AuthRecord): Promise<void>;
  delete(providerId: string): Promise<void>;
}
```

### 39.3 Secret Handling

Auth records must never be:

- shown in TUI
- written to event logs
- included in model context
- stored in memory
- exposed to hooks unless explicitly allowed

---

## 40. Network Architecture

### 40.1 Network Policy

Network access should be controlled separately from filesystem access.

```ts
export interface NetworkPolicy {
  default: "off" | "on" | "restricted";
  allowedHosts: string[];
  blockedHosts: string[];
}
```

### 40.2 Provider Calls

Model provider calls are allowed according to provider config.

Tool/network calls are separate from model calls.

Example:

```text
Model API call allowed
Shell command network access denied
MCP remote server denied unless allowlisted
```

### 40.3 Shell Network Control

Pure TypeScript cannot reliably block all network access for arbitrary child processes without OS/container support.

Therefore:

- Nexus policy decides whether network is allowed.
- Sandbox adapter enforces where possible.
- If hard network blocking is required but unavailable, Nexus denies the command.

---

## 41. Platform Architecture

### 41.1 Target Platforms

MVP target:

```text
macOS
Linux
Windows
```

### 41.2 Platform Adapter

```ts
export interface PlatformAdapter {
  platform: NodeJS.Platform;
  detectShell(): Promise<ShellInfo>;
  detectPackageManagers(): Promise<PackageManagerInfo[]>;
  resolveSandboxCapabilities(): Promise<SandboxCapability[]>;
  openExternal?(target: string): Promise<void>;
}
```

### 41.3 Platform Differences

| Capability | macOS | Linux | Windows |
|---|---|---|---|
| shell execution | yes | yes | yes |
| filesystem guard | TypeScript guard + OS adapter | TypeScript guard + OS adapter | TypeScript guard + OS adapter |
| hard sandbox | external adapter needed | external adapter/container preferred | external adapter/container preferred |
| pseudo-terminal TUI | supported | supported | supported |
| container sandbox | optional | optional | optional |

---

## 42. Release Safety Architecture

### 42.1 Release Checklist

Before publishing:

- run tests
- run security tests
- run package dry-run
- verify package file list
- verify no credentials
- verify no unintended source maps
- verify no local `.nexus` files
- verify no fixture secrets
- verify lockfile integrity
- verify CLI smoke test
- verify install from packed tarball

### 42.2 Package Verification Script

Release CI should inspect:

```text
npm pack output
tarball file list
dist files
source maps
.env files
auth files
private keys
large unexpected files
```

### 42.3 Source Map Policy

For public open-source releases, source maps may still be allowed if deliberate.

For private/closed releases, source maps must be excluded by default.

---

## 43. Core Type Definitions

### 43.1 Branded IDs

```ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type EventId = Brand<string, "EventId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type PlanId = Brand<string, "PlanId">;
export type MemoryId = Brand<string, "MemoryId">;
```

### 43.2 User Input

```ts
export interface UserTurnInput {
  text: string;
  attachments?: Attachment[];
  slashCommand?: SlashCommandIntent;
  createdAt: string;
}
```

### 43.3 Runtime Context

```ts
export interface RuntimeContext {
  session: NexusSession;
  config: ResolvedConfig;
  eventBus: EventBus;
  storage: StorageLayer;
  security: SecurityRuntime;
  tools: ToolBus;
  models: ModelRouter;
}
```

### 43.4 Permission Requirement

```ts
export interface PermissionRequirement {
  kind:
    | "filesystem.read"
    | "filesystem.write"
    | "shell.run"
    | "network.access"
    | "mcp.call"
    | "memory.write";
  scope?: string;
  risk: RiskLevel;
  reason: string;
}
```

---

## 44. Main Runtime Sequence

### 44.1 Interactive Coding Task

```text
User starts:
  nexus

TUI starts:
  render empty session

User asks:
  "Add retry logic to payment flow"

Runtime:
  create turn
  emit user.input

SDLC:
  discover repo
  emit sdlc.stage.started:discover
  build repo map
  read AGENTS.md

Context:
  compile prompt
  inject relevant files

Model:
  produce plan

TUI:
  show plan

User:
  approves plan

Runtime:
  request file edits
  policy check
  approval check
  sandbox prepare
  apply patch

Verify:
  run test command
  summarize result

Review:
  inspect diff

Learning:
  generate memory candidates

TUI:
  show final summary
```

### 44.2 Non-Interactive Coding Task

```text
User starts:
  nexus exec --json "Fix failing test"

Runtime:
  create session
  stream events to stdout

Agent:
  discover
  plan
  implement if policy allows
  verify
  review
  learn candidates

Output:
  events.jsonl
  final answer
  patch artifact

Exit:
  0 if success
  6 if verification failed
  2 if approval required
```

---

## 45. Security-Critical Invariants

These invariants must never be violated.

### 45.1 No Model Direct Execution

The model cannot execute tools directly.

### 45.2 No Direct Filesystem Mutation

All file writes must go through Tool Bus and Security Runtime.

### 45.3 No Silent Permission Escalation

Sandbox or approval level cannot be escalated silently.

### 45.4 No Memory Write Without Policy

Memory writes must pass:

```text
candidate generation
  ↓
secrets scan
  ↓
scope classification
  ↓
policy check
  ↓
approval if required
```

### 45.5 No Protected Path Writes By Default

Protected paths cannot be modified without explicit approval and policy allowance.

### 45.6 No Hard Sandbox Downgrade

If hard sandbox is required and unavailable, deny.

### 45.7 No Unredacted Secrets In Logs

Secrets must be redacted before writing persistent logs.

### 45.8 No Tool Output As Instruction

Tool output must be treated as data, not instruction.

---

## 46. MVP Architecture Scope

### 46.1 MVP Includes

- TypeScript monorepo
- `nexus` interactive command
- `nexus exec` non-interactive command
- TUI
- event bus
- JSONL events
- session storage
- config resolver
- AGENTS.md loader
- model router with one provider
- file tool
- patch tool
- shell tool
- git helper
- test command helper
- basic security runtime
- basic sandbox adapter
- approval engine
- Agentic SDLC state machine
- Learning Plane in `suggest` mode
- memory candidate generation
- `/plan`
- `/goal`
- `/diff`
- `/review`
- `/status`
- `/compact`
- `/memories`
- `/permissions`
- `/model`
- `/agent` placeholder or basic thread manager
- local run artifacts

### 46.2 MVP Excludes

- full plugin marketplace
- full enterprise admin console
- hosted cloud sync
- remote runners
- complete multi-provider support
- complete subagent parallelism
- organization-wide memory sharing
- IDE extension
- browser companion
- hosted eval dashboard

---

## 47. Recommended Implementation Order

This section is architectural sequencing, not a detailed implementation plan.

```text
1. shared types
2. config system
3. event bus and JSONL writer
4. storage layer
5. CLI command router
6. runtime/session manager
7. model provider interface and fake provider
8. basic TUI shell
9. context engine MVP
10. file/git/search tools
11. security runtime MVP
12. shell tool with risk scoring
13. approval engine
14. patch/checkpoint/rollback
15. Agentic SDLC state machine
16. model provider adapter
17. interactive coding loop
18. non-interactive exec loop
19. review and verification
20. Learning Plane candidate generation
21. memory storage
22. MCP MVP
23. skills MVP
24. subagent MVP
25. eval harness
```

---

## 48. Architecture Decision Records

### ADR-001: TypeScript-Only Runtime

Decision:

Nexus application source code will be fully TypeScript.

Rationale:

- Faster iteration
- Unified frontend/TUI/runtime language
- Easier plugin ecosystem
- Easier model/provider integration
- Easier JSON/event/schema handling
- Better fit for npm-distributed CLI

Tradeoff:

- Hard OS sandboxing cannot be implemented purely in TypeScript.
- Nexus must use external OS/container primitives through adapters.

### ADR-002: Event-Sourced Runtime

Decision:

Runtime state will be event-first.

Rationale:

- TUI projection
- JSONL non-interactive output
- replay
- audit
- debugging
- evals
- learning

Tradeoff:

- Requires careful event schema design.
- Requires event versioning.

### ADR-003: Familiar Codex-Style UX

Decision:

Nexus will use the established terminal-agent UX pattern.

Rationale:

- Lower adoption friction
- Familiar slash commands
- Familiar sandbox/approval concepts
- Familiar interactive/non-interactive split

Tradeoff:

- Product differentiation must happen in runtime depth, not surface novelty.

### ADR-004: Filesystem-First Storage

Decision:

MVP uses local filesystem storage, JSONL, Markdown and JSON.

Rationale:

- No native database dependency
- Easy inspection
- Easy debugging
- Works in repos and CI
- Good for local-first privacy

Tradeoff:

- Large-scale querying requires future indexing layer.

### ADR-005: Provider Abstraction

Decision:

Core runtime depends only on provider interfaces.

Rationale:

- Model-agnostic design
- Future provider flexibility
- Enterprise model allowlist support

Tradeoff:

- Provider-specific features must be normalized carefully.

### ADR-006: Policy Before Tool Execution

Decision:

Every tool call must pass through Security Runtime.

Rationale:

- Prevent unsafe execution
- Provide auditability
- Enforce enterprise controls
- Maintain user trust

Tradeoff:

- Adds latency and implementation complexity.

---

## 49. Final Architecture Definition

Nexus CLI is a fully TypeScript, local-first, event-sourced, policy-driven terminal coding agent runtime.

It presents a familiar Codex-style CLI and TUI:

```bash
nexus
nexus exec
/plan
/diff
/review
/status
/memories
```

But internally it is a layered runtime:

```text
TUI / CLI
  ↓
Session Runtime
  ↓
Agent Orchestrator
  ↓
Agentic SDLC Plane
  ↓
Context Engine
  ↓
Model Router
  ↓
Tool Bus
  ↓
Security Runtime
  ↓
Sandbox Adapter
  ↓
Event Store
  ↓
Learning Plane
```

The defining architectural commitments are:

1. **TypeScript-only application code**
2. **Codex-style familiar terminal UX**
3. **Event-sourced observable runtime**
4. **Agentic SDLC-aware task lifecycle**
5. **Scoped, consent-based Learning Plane**
6. **Tool execution through policy and approval**
7. **Local-first storage and privacy**
8. **Model-provider abstraction**
9. **Sandbox adapter architecture**
10. **Enterprise-ready extension points**

Nexus should feel familiar on the surface and significantly more disciplined underneath.

The final product architecture can be summarized as:

> **Nexus CLI = Codex-style TypeScript TUI + policy-driven Tool Bus + Agentic SDLC Plane + Learning Plane + event-sourced local development runtime.**