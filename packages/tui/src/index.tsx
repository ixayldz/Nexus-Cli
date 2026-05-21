import { type ResolvedConfig } from "@nexus/config";
import { type NexusEvent } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import { Box, Text, render as renderInk, useInput } from "ink";
import { type ReactElement, useMemo, useState } from "react";

export interface TuiTranscriptEntry {
  kind:
    | "session"
    | "user"
    | "assistant"
    | "tool"
    | "approval"
    | "file"
    | "shell"
    | "git"
    | "search"
    | "sdlc"
    | "learning"
    | "system"
    | "error";
  text: string;
  collapsed?: boolean;
}

export interface TuiState {
  sessionId?: SessionId;
  cwd?: string;
  model: string;
  provider: string;
  sandbox: string;
  approval: string;
  branch: string;
  learningMode: string;
  sdlcStage: string;
  goal?: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
  };
  pendingLearningCandidates: number;
  activeTools: string[];
  activeProcesses: ProcessCard[];
  transcript: TuiTranscriptEntry[];
  pendingApproval?: ApprovalCard;
  lastDiff?: string;
}

export interface ProcessCard {
  label: string;
  status: "running" | "completed";
}

export interface ApprovalCard {
  requestId?: string;
  tool: string;
  risk: string;
  reason: string;
  target?: string;
  sandbox?: string;
  detailsOpen?: boolean;
}

export interface RuntimeIntent {
  type:
    | "status.show"
    | "config.debug"
    | "model.show"
    | "model.fast"
    | "permissions.show"
    | "theme.show"
    | "statusline.show"
    | "raw.show"
    | "copy.last"
    | "mention.add"
    | "diff.show"
    | "sdlc.goal.set"
    | "sdlc.plan"
    | "sdlc.verify"
    | "review.start"
    | "ship.start"
    | "rollback.start"
    | "agent.open"
    | "mcp.open"
    | "skills.open"
    | "hooks.open"
    | "context.compact"
    | "memories.open"
    | "approval.approve"
    | "approval.approve_session"
    | "approval.deny"
    | "approval.details"
    | "approval.list"
    | "process.list"
    | "process.stop"
    | "session.new"
    | "session.resume"
    | "session.fork"
    | "session.side"
    | "project.init"
    | "apps.open"
    | "plugins.open"
    | "experimental.open"
    | "sandbox.add_read_dir"
    | "keymap.show"
    | "vim.toggle"
    | "slash.help"
    | "transcript.clear"
    | "session.quit"
    | "placeholder";
  command?: string;
  argument?: string;
  message?: string;
}

export const slashCommands = [
  "/model",
  "/fast",
  "/permissions",
  "/theme",
  "/statusline",
  "/raw",
  "/copy",
  "/mention",
  "/approvals",
  "/approve",
  "/approve-session",
  "/deny",
  "/status",
  "/debug-config",
  "/plan",
  "/goal",
  "/diff",
  "/verify",
  "/review",
  "/ship",
  "/rollback",
  "/compact",
  "/memories",
  "/agent",
  "/mcp",
  "/skills",
  "/hooks",
  "/ps",
  "/stop",
  "/clear",
  "/new",
  "/resume",
  "/fork",
  "/side",
  "/init",
  "/apps",
  "/plugins",
  "/experimental",
  "/sandbox-add-read-dir",
  "/keymap",
  "/vim",
  "/quit",
  "/exit",
  "/help"
] as const;

export function createInitialTuiState(config: ResolvedConfig): TuiState {
  return {
    model: config.model,
    provider: config.modelProvider,
    sandbox: config.sandboxMode,
    approval: config.approvalPolicy,
    branch: "unknown",
    learningMode: config.learning.mode,
    sdlcStage: "none",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    pendingLearningCandidates: 0,
    activeTools: [],
    activeProcesses: [],
    transcript: []
  };
}

export function reduceTuiEvent(state: TuiState, event: NexusEvent): TuiState {
  const next: TuiState = {
    ...state,
    tokenUsage: { ...state.tokenUsage },
    transcript: [...state.transcript],
    activeTools: [...state.activeTools],
    activeProcesses: [...state.activeProcesses]
  };

  switch (event.type) {
    case "session.started":
      next.sessionId = event.sessionId;
      assignString(event, "cwd", (value) => {
        next.cwd = value;
      });
      next.transcript.push({ kind: "session", text: `Session started: ${event.sessionId}` });
      break;
    case "user.input":
      next.transcript.push({ kind: "user", text: readString(event, "text") ?? "" });
      break;
    case "assistant.message":
      next.transcript.push({ kind: "assistant", text: collapseLongText(readString(event, "text") ?? "") });
      break;
    case "assistant.delta":
      next.transcript.push({ kind: "assistant", text: collapseLongText(readString(event, "text") ?? "") });
      break;
    case "model.call.started":
      assignString(event, "model", (value) => {
        next.model = value;
      });
      assignString(event, "provider", (value) => {
        next.provider = value;
      });
      break;
    case "model.call.completed":
      updateTokenUsage(next, readUnknown(event, "usage"));
      break;
    case "model.usage":
      updateTokenUsage(next, readUnknown(event, "usage"));
      break;
    case "tool.requested": {
      const tool = readString(event, "tool") ?? "unknown";
      next.activeTools.push(tool);
      next.transcript.push({ kind: "tool", text: `Tool requested: ${tool}` });
      break;
    }
    case "tool.risk":
      next.transcript.push({
        kind: "tool",
        text: `Risk ${readString(event, "risk") ?? "unknown"}: ${readString(event, "tool") ?? "unknown"}`
      });
      break;
    case "tool.completed": {
      const tool = readString(event, "tool") ?? "unknown";
      next.activeTools = next.activeTools.filter((activeTool) => activeTool !== tool);
      next.transcript.push({
        kind: "tool",
        text: `${tool} ${readString(event, "status") ?? "completed"}: ${readString(event, "summary") ?? ""}`
      });
      break;
    }
    case "approval.required":
      {
        const requestId = readString(event, "requestId");
        const target = readString(event, "target");
        const sandbox = readString(event, "sandbox");
        next.pendingApproval = {
          ...(requestId ? { requestId } : {}),
          tool: readString(event, "tool") ?? "unknown",
          risk: readString(event, "risk") ?? "unknown",
          reason: readString(event, "reason") ?? "",
          ...(target ? { target } : {}),
          ...(sandbox ? { sandbox } : {})
        };
        next.transcript.push({
          kind: "approval",
          text: renderApprovalCard(next.pendingApproval)
        });
      }
      break;
    case "approval.granted":
    case "approval.denied":
      delete next.pendingApproval;
      next.transcript.push({ kind: "approval", text: event.type });
      break;
    case "sandbox.unavailable":
      next.transcript.push({ kind: "error", text: `Sandbox unavailable: ${readString(event, "reason") ?? ""}` });
      break;
    case "file.read":
      next.transcript.push({
        kind: "file",
        text: `Read ${readString(event, "path") ?? "file"} (${String(readUnknown(event, "size") ?? "?")} bytes)`
      });
      break;
    case "file.changed":
      assignString(event, "diff", (value) => {
        next.lastDiff = value;
      });
      next.transcript.push({ kind: "file", text: `Changed ${readString(event, "path") ?? "file"}` });
      break;
    case "rollback.started":
      next.transcript.push({ kind: "file", text: `Rollback started: ${readString(event, "checkpointId") ?? "latest"}` });
      break;
    case "rollback.completed":
      next.transcript.push({ kind: "file", text: `Rollback completed: ${readString(event, "checkpointId") ?? ""}` });
      break;
    case "rollback.refused":
      next.transcript.push({ kind: "error", text: `Rollback refused: ${readString(event, "refusedReason") ?? "policy denied"}` });
      break;
    case "shell.started": {
      const command = readString(event, "command") ?? "shell command";
      next.activeProcesses.push({ label: command, status: "running" });
      next.transcript.push({ kind: "shell", text: `Running: ${command}` });
      break;
    }
    case "shell.output": {
      const text = readString(event, "text");
      if (text) {
        next.transcript.push({ kind: "shell", text: collapseLongText(text), collapsed: text.length > 240 });
      }
      break;
    }
    case "shell.completed": {
      const command = readString(event, "command") ?? "";
      next.activeProcesses = next.activeProcesses.filter((process) => process.label !== command);
      next.transcript.push({
        kind: "shell",
        text: `Command exited ${String(readUnknown(event, "exitCode") ?? "?")}: ${command}`
      });
      break;
    }
    case "git.status":
      assignString(event, "branch", (value) => {
        next.branch = value;
      });
      next.transcript.push({ kind: "git", text: `${event.type} exit ${String(readUnknown(event, "exitCode") ?? "?")}` });
      break;
    case "git.diff":
      assignString(event, "diff", (value) => {
        next.lastDiff = value;
      });
      next.transcript.push({ kind: "git", text: `${event.type} exit ${String(readUnknown(event, "exitCode") ?? "?")}` });
      break;
    case "git.log":
      next.transcript.push({ kind: "git", text: `${event.type} exit ${String(readUnknown(event, "exitCode") ?? "?")}` });
      break;
    case "search.completed":
      next.transcript.push({
        kind: "search",
        text: `Search '${readString(event, "query") ?? ""}' found ${String(readUnknown(event, "matchCount") ?? 0)} match(es)`
      });
      break;
    case "sdlc.goal.updated": {
      const goal = readString(event, "goal") ?? "Goal updated";
      next.goal = goal;
      next.sdlcStage = "plan";
      next.transcript.push({ kind: "sdlc", text: `Goal: ${goal}` });
      break;
    }
    case "sdlc.definition_of_done.updated":
      next.transcript.push({ kind: "sdlc", text: "Definition of done updated" });
      break;
    case "sdlc.stage.started": {
      const stage = readString(event, "stage") ?? "unknown";
      next.sdlcStage = stage;
      next.transcript.push({ kind: "sdlc", text: `Stage started: ${stage}` });
      break;
    }
    case "sdlc.stage.completed": {
      const stage = readString(event, "stage") ?? "unknown";
      next.transcript.push({ kind: "sdlc", text: `Stage completed: ${stage}` });
      break;
    }
    case "sdlc.stage.blocked":
      next.transcript.push({ kind: "sdlc", text: `Stage blocked: ${readString(event, "reason") ?? "unknown"}` });
      break;
    case "plan.updated":
      next.sdlcStage = "plan";
      next.transcript.push({ kind: "sdlc", text: renderPlanSummary(readUnknown(event, "plan")) });
      break;
    case "verification.completed":
      next.sdlcStage = "verify";
      next.transcript.push({
        kind: "sdlc",
        text: `Verification ${readString(event, "status") ?? "completed"}: ${readString(event, "summary") ?? ""}`
      });
      break;
    case "review.completed":
      next.sdlcStage = "review";
      next.transcript.push({
        kind: "sdlc",
        text: `Review ${readString(event, "status") ?? "completed"}: ${readString(event, "summary") ?? ""}`
      });
      break;
    case "ship.completed":
      next.sdlcStage = "ship";
      next.transcript.push({
        kind: "sdlc",
        text: `Ship ${readString(event, "status") ?? "completed"}: ${readString(event, "summary") ?? ""}`
      });
      break;
    case "learning.candidate.created":
      next.pendingLearningCandidates += 1;
      next.transcript.push({ kind: "learning", text: renderLearningCandidate(readUnknown(event, "candidate")) });
      break;
    case "learning.candidate.accepted":
      next.pendingLearningCandidates = Math.max(0, next.pendingLearningCandidates - 1);
      next.transcript.push({ kind: "learning", text: `Accepted memory candidate ${readString(event, "candidateId") ?? ""}` });
      break;
    case "learning.candidate.rejected":
      next.pendingLearningCandidates = Math.max(0, next.pendingLearningCandidates - 1);
      next.transcript.push({ kind: "learning", text: `Rejected memory candidate ${readString(event, "candidateId") ?? ""}` });
      break;
    case "memory.written":
      next.transcript.push({ kind: "learning", text: `Memory written: ${readString(event, "path") ?? "project memory"}` });
      break;
    case "session.completed":
      next.transcript.push({ kind: "session", text: "Session turn completed" });
      break;
    case "error":
      next.transcript.push({ kind: "error", text: readString(event, "message") ?? "Unknown error" });
      break;
    default:
      break;
  }

  next.transcript = next.transcript.slice(-200);
  return next;
}

export function parseSlashCommand(input: string): RuntimeIntent {
  const trimmed = input.trim();
  const [command = ""] = trimmed.split(/\s+/);
  const argument = trimmed.slice(command.length).trim();
  switch (command) {
    case "/status":
      return { type: "status.show" };
    case "/debug-config":
      return { type: "config.debug" };
    case "/model":
      return { type: "model.show" };
    case "/fast":
      return { type: "model.fast", command, argument };
    case "/permissions":
      return { type: "permissions.show" };
    case "/theme":
      return { type: "theme.show", command, argument };
    case "/statusline":
      return { type: "statusline.show", command, argument };
    case "/raw":
      return { type: "raw.show", command, argument };
    case "/copy":
      return { type: "copy.last", command, argument };
    case "/mention":
      return { type: "mention.add", command, argument };
    case "/diff":
      return { type: "diff.show" };
    case "/goal":
      return { type: "sdlc.goal.set", command, argument };
    case "/plan":
      return { type: "sdlc.plan", command, argument };
    case "/verify":
      return { type: "sdlc.verify", command, argument };
    case "/review":
      return { type: "review.start", command, argument };
    case "/ship":
      return { type: "ship.start", command, argument };
    case "/rollback":
      return { type: "rollback.start", command, argument };
    case "/agent":
      return { type: "agent.open", command, argument };
    case "/mcp":
      return { type: "mcp.open", command, argument };
    case "/skills":
      return { type: "skills.open", command, argument };
    case "/hooks":
      return { type: "hooks.open", command, argument };
    case "/compact":
      return { type: "context.compact", command, argument };
    case "/memories":
      return { type: "memories.open", command, argument };
    case "/approvals":
      return { type: "approval.list", command, argument };
    case "/approve":
      return argument === "session"
        ? { type: "approval.approve_session", command, argument: "" }
        : { type: "approval.approve", command, argument };
    case "/approve-session":
      return { type: "approval.approve_session", command, argument };
    case "/deny":
      return { type: "approval.deny", command, argument };
    case "/ps":
      return { type: "process.list", command, argument };
    case "/stop":
      return { type: "process.stop", command, argument };
    case "/new":
      return { type: "session.new", command, argument };
    case "/resume":
      return { type: "session.resume", command, argument };
    case "/fork":
      return { type: "session.fork", command, argument };
    case "/side":
      return { type: "session.side", command, argument };
    case "/init":
      return { type: "project.init", command, argument };
    case "/apps":
      return { type: "apps.open", command, argument };
    case "/plugins":
      return { type: "plugins.open", command, argument };
    case "/experimental":
      return { type: "experimental.open", command, argument };
    case "/sandbox-add-read-dir":
      return { type: "sandbox.add_read_dir", command, argument };
    case "/keymap":
      return { type: "keymap.show", command, argument };
    case "/vim":
      return { type: "vim.toggle", command, argument };
    case "/help":
      return { type: "slash.help" };
    case "/clear":
      return { type: "transcript.clear" };
    case "/quit":
    case "/exit":
      return { type: "session.quit" };
    default:
      if (slashCommands.includes(command as (typeof slashCommands)[number])) {
        return {
          type: "placeholder",
          command,
          message: `${command} is recognized but not implemented in this build.`
        };
      }
      return {
        type: "placeholder",
        command,
        message: `${command || "Slash command"} is not supported. Use /help.`
      };
  }
}

export interface NexusTuiAppProps {
  state: TuiState;
  isRunning?: boolean;
  onSubmitPrompt?: (text: string) => void | Promise<void>;
  onIntent?: (intent: RuntimeIntent) => void | Promise<void>;
}

export function NexusTuiApp(props: NexusTuiAppProps): ReactElement {
  const [composer, setComposer] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteOpen = composer.trimStart().startsWith("/");
  const paletteItems = useMemo(() => filterSlashCommands(composer), [composer]);
  const selectedCommand = paletteItems[Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))];

  useInput((inputText, key) => {
    if (key.ctrl && inputText === "c") {
      void props.onIntent?.({ type: "session.quit" });
      return;
    }
    if (key.escape) {
      setComposer("");
      setPaletteIndex(0);
      return;
    }
    if (paletteOpen && key.upArrow) {
      setPaletteIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (paletteOpen && key.downArrow) {
      setPaletteIndex((value) => Math.min(Math.max(0, paletteItems.length - 1), value + 1));
      return;
    }
    if (paletteOpen && key.tab && selectedCommand) {
      setComposer(`${selectedCommand} `);
      setPaletteIndex(0);
      return;
    }
    if (key.return) {
      const value = composer.trim();
      if (!value || props.isRunning) {
        return;
      }
      setComposer("");
      setPaletteIndex(0);
      if (value.startsWith("/")) {
        void props.onIntent?.(parseSlashCommand(value));
      } else {
        void props.onSubmitPrompt?.(value);
      }
      return;
    }
    if (key.ctrl && inputText === "j") {
      setComposer((value) => `${value}\n`);
      return;
    }
    if (key.backspace || key.delete) {
      setComposer((value) => value.slice(0, -1));
      return;
    }
    if (inputText && !key.ctrl && !key.meta) {
      setComposer((value) => `${value}${inputText}`);
      setPaletteIndex(0);
    }
  });

  return (
    <Box flexDirection="column" minHeight={20}>
      <StatusLine state={props.state} />
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} marginRight={1}>
          <TranscriptView entries={props.state.transcript} />
          <DiffViewer {...(props.state.lastDiff ? { diff: props.state.lastDiff } : {})} />
        </Box>
        <Box flexDirection="column" width={34}>
          <ApprovalCardView
            {...(props.state.pendingApproval ? { card: props.state.pendingApproval } : {})}
            {...(props.onIntent ? { onIntent: props.onIntent } : {})}
          />
          <ProcessPanel processes={props.state.activeProcesses} activeTools={props.state.activeTools} />
          <MemoryPanel pendingCount={props.state.pendingLearningCandidates} />
        </Box>
      </Box>
      <SlashCommandPalette open={paletteOpen} commands={paletteItems} selectedIndex={paletteIndex} />
      <Composer value={composer} disabled={props.isRunning === true} />
    </Box>
  );
}

export function TranscriptView(input: { entries: TuiTranscriptEntry[] }): ReactElement {
  const visible = input.entries.slice(-12);
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1} minHeight={10}>
      <Text bold>Transcript</Text>
      {visible.length === 0 ? <Text color="gray">No events yet.</Text> : null}
      {visible.map((entry, index) => {
        const color = colorForEntry(entry.kind);
        const text = renderTranscriptEntry(entry);
        return color ? (
          <Text key={`${index}-${entry.kind}`} color={color}>
            {text}
          </Text>
        ) : (
          <Text key={`${index}-${entry.kind}`}>{text}</Text>
        );
      })}
    </Box>
  );
}

export function Composer(input: { value: string; disabled?: boolean }): ReactElement {
  const marker = input.disabled ? "running" : "ready";
  const rendered = input.value.length > 0 ? input.value : "Type a prompt or / for commands";
  return (
    <Box borderStyle="single" paddingX={1}>
      <Text color={input.disabled ? "yellow" : "green"}>{marker}</Text>
      <Text> {rendered}</Text>
    </Box>
  );
}

export function SlashCommandPalette(input: {
  open: boolean;
  commands: string[];
  selectedIndex: number;
}): ReactElement | null {
  if (!input.open) {
    return null;
  }
  const commands = input.commands.slice(0, 8);
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>Commands</Text>
      {commands.map((command, index) => (
        <Text key={command} inverse={index === input.selectedIndex}>
          {command}
        </Text>
      ))}
    </Box>
  );
}

export function ApprovalCardView(input: {
  card?: ApprovalCard;
  onIntent?: (intent: RuntimeIntent) => void | Promise<void>;
}): ReactElement {
  if (!input.card) {
    return (
      <Box borderStyle="single" flexDirection="column" paddingX={1}>
        <Text bold>Approval</Text>
        <Text color="gray">No pending approval.</Text>
      </Box>
    );
  }

  const requestId = input.card.requestId ?? "";
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold color="yellow">
        Approval Required
      </Text>
      <Text>{input.card.tool}</Text>
      <Text>risk: {input.card.risk}</Text>
      <Text>sandbox: {input.card.sandbox ?? "current"}</Text>
      {input.card.target ? <Text>target: {input.card.target}</Text> : null}
      <Text>{input.card.reason}</Text>
      <Box>
        <Text color="green" underline>
          approve
        </Text>
        <Text> </Text>
        <Text color="cyan" underline>
          session
        </Text>
        <Text> </Text>
        <Text color="red" underline>
          deny
        </Text>
      </Box>
      <Text color="gray">/approve {requestId} | /approve-session {requestId} | /deny {requestId}</Text>
    </Box>
  );
}

export function DiffViewer(input: { diff?: string }): ReactElement {
  const diff = input.diff?.trim();
  const lines = diff ? diff.split(/\r?\n/).slice(0, 8) : [];
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1} minHeight={4}>
      <Text bold>Diff</Text>
      {lines.length === 0 ? <Text color="gray">No diff available.</Text> : null}
      {lines.map((line, index) => {
        const color = line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined;
        return color ? (
          <Text key={`${index}-${line}`} color={color}>
            {line}
          </Text>
        ) : (
          <Text key={`${index}-${line}`}>{line}</Text>
        );
      })}
    </Box>
  );
}

export function StatusLine(input: { state: TuiState }): ReactElement {
  return (
    <Box paddingX={1}>
      <Text inverse>{renderStatusLine(input.state)}</Text>
    </Box>
  );
}

export function ProcessPanel(input: { processes: ProcessCard[]; activeTools: string[] }): ReactElement {
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>Processes</Text>
      {input.activeTools.length === 0 && input.processes.length === 0 ? <Text color="gray">Idle.</Text> : null}
      {input.activeTools.map((tool) => (
        <Text key={`tool-${tool}`}>tool: {tool}</Text>
      ))}
      {input.processes.map((process) => (
        <Text key={`process-${process.label}`}>
          {process.status}: {process.label}
        </Text>
      ))}
    </Box>
  );
}

export function MemoryPanel(input: { pendingCount: number }): ReactElement {
  return (
    <Box borderStyle="single" flexDirection="column" paddingX={1}>
      <Text bold>Memory</Text>
      <Text>pending: {input.pendingCount}</Text>
    </Box>
  );
}

export interface NexusTuiRenderer {
  rerender(input: NexusTuiAppProps): void;
  unmount(): void;
  waitUntilExit(): Promise<void>;
}

export function renderNexusTuiApp(input: NexusTuiAppProps): NexusTuiRenderer {
  const instance = renderInk(<NexusTuiApp {...input} />, { exitOnCtrlC: false });
  return {
    rerender(nextInput: NexusTuiAppProps): void {
      instance.rerender(<NexusTuiApp {...nextInput} />);
    },
    unmount(): void {
      instance.unmount();
    },
    waitUntilExit(): Promise<void> {
      return instance.waitUntilExit().then(() => undefined);
    }
  };
}

export function renderStatusLine(state: TuiState): string {
  return [
    `model: ${state.provider}/${state.model}`,
    `sandbox: ${state.sandbox}`,
    `approval: ${state.approval}`,
    `branch: ${state.branch}`,
    `tokens: ${state.tokenUsage.inputTokens}/${state.tokenUsage.outputTokens}`,
    `SDLC: ${state.sdlcStage}`,
    `learning: ${state.learningMode}`,
    `memories: ${state.pendingLearningCandidates}`,
    `session: ${state.sessionId ?? "none"}`
  ].join(" | ");
}

export function renderSlashPalette(): string {
  return `Commands: ${slashCommands.join(" ")}`;
}

export function renderTranscriptEntry(entry: TuiTranscriptEntry): string {
  const label = {
    session: "session",
    user: "user",
    assistant: "assistant",
    tool: "tool",
    approval: "approval",
    file: "file",
    shell: "shell",
    git: "git",
    search: "search",
    sdlc: "sdlc",
    learning: "learning",
    system: "system",
    error: "error"
  }[entry.kind];
  return `[${label}] ${entry.text}`;
}

export function renderApprovalCard(card: ApprovalCard): string {
  const request = card.requestId ? ` ${card.requestId}` : "";
  const target = card.target ? ` | target: ${card.target}` : "";
  const sandbox = card.sandbox ? ` | sandbox: ${card.sandbox}` : "";
  return `Approval required${request} for ${card.tool} | risk: ${card.risk}${sandbox}${target} | ${card.reason}`;
}

export function clearTranscript(state: TuiState): TuiState {
  return {
    ...state,
    transcript: []
  };
}

export function filterSlashCommands(value: string): string[] {
  const query = value.trimStart().replace(/^\//, "").toLowerCase();
  if (!query) {
    return [...slashCommands];
  }
  return slashCommands.filter((command) => command.slice(1).startsWith(query));
}

function updateTokenUsage(state: TuiState, value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const inputTokens = readNumber(value, "inputTokens");
  const outputTokens = readNumber(value, "outputTokens");
  state.tokenUsage = {
    inputTokens: state.tokenUsage.inputTokens + (inputTokens ?? 0),
    outputTokens: state.tokenUsage.outputTokens + (outputTokens ?? 0)
  };
}

function assignString(event: NexusEvent, key: string, assign: (value: string) => void): void {
  const value = readString(event, key);
  if (value) {
    assign(value);
  }
}

function readString(event: NexusEvent | Record<string, unknown> | undefined, key: string): string | undefined {
  const value = event?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "number" ? nested : undefined;
}

function readUnknown(event: NexusEvent, key: string): unknown {
  return event[key];
}

function renderPlanSummary(plan: unknown): string {
  if (typeof plan !== "object" || plan === null) {
    return "Plan updated";
  }
  const value = plan as { goal?: unknown; steps?: unknown; verification?: unknown };
  const goal = typeof value.goal === "string" ? value.goal : "requested task";
  const stepCount = Array.isArray(value.steps) ? value.steps.length : 0;
  const verificationCount = Array.isArray(value.verification) ? value.verification.length : 0;
  return `Plan updated for ${goal} (${stepCount} step(s), ${verificationCount} verification command(s))`;
}

function renderLearningCandidate(candidate: unknown): string {
  if (typeof candidate !== "object" || candidate === null) {
    return "Learning candidate created";
  }
  const value = candidate as { type?: unknown; text?: unknown; confidence?: unknown };
  const type = typeof value.type === "string" ? value.type : "memory";
  const text = typeof value.text === "string" ? value.text : "candidate";
  const confidence = typeof value.confidence === "number" ? ` (${Math.round(value.confidence * 100)}%)` : "";
  return `Learning candidate [${type}]${confidence}: ${text}`;
}

function collapseLongText(text: string): string {
  if (text.length <= 240) {
    return text;
  }
  return `${text.slice(0, 220)}... (${text.length - 220} more chars)`;
}

function colorForEntry(kind: TuiTranscriptEntry["kind"]): "blue" | "green" | "yellow" | "red" | "cyan" | "gray" | undefined {
  switch (kind) {
    case "assistant":
      return "green";
    case "approval":
      return "yellow";
    case "error":
      return "red";
    case "shell":
      return "cyan";
    case "system":
      return "gray";
    default:
      return undefined;
  }
}
