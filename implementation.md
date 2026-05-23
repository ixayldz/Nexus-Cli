# Nexus CLI PRD Readiness Completion Implementation Plan

**Product:** Nexus CLI  
**Platform:** Nexus Weaver  
**Document Type:** PRD Readiness Completion Implementation Plan  
**Status:** Draft v1.0  
**Primary Language:** TypeScript  
**Objective:** Mevcut çalışan MVP runtime seviyesinden tam PRD-ready, trusted alpha/private beta adayı ve production-grade Codex-class CLI seviyesine geçiş için kalan eksikleri kapatmak.

---

## 1. Executive Summary

Nexus CLI mevcut durumda ciddi bir çalışan MVP seviyesine ulaşmıştır. CLI, TUI, `nexus exec`, JSONL event stream, session storage, context compiler, Tool Bus, approval policy, protected paths, basic sandbox guard, SDLC Plane, Learning Plane, artifacts, eval ve release verification gibi temel runtime mekanizmaları vardır.

Ancak PRD'de tarif edilen production-grade, Codex-class, güvenli ve öğrenen terminal agent deneyimi için bazı kritik eksikler kapatılmalıdır.

Bu implementation plan, kalan açıkları kapatmak için hazırlanmıştır.

Ana hedef:

```text
Current state:
  Working MVP runtime

Target state:
  PRD-ready Nexus CLI
  Trusted alpha ready
  Private beta ready
  Production-grade architecture foundation
```

Kapatılacak ana eksikler:

```text
1. Hard sandbox eksikliği
2. TUI/UX Codex-standard polish eksikliği
3. Live provider validation eksikliği
4. Gerçek subagent runtime eksikliği
5. MCP governance eksikliği
6. Review/plan intelligence kalitesinin sınırlı olması
7. Learning Plane'in MVP seviyesinde kalması
8. Ship stage'in zayıf olması
9. Real repository validation eksikliği
10. Eval/release readiness'in ürün kalitesini tam ölçmemesi
11. Documentation ve acceptance evidence eksikliği
```

Bu planın nihai çıktısı:

```text
Nexus CLI artık yalnızca çalışan MVP değil;
güvenli, test edilmiş, real-repo validation'dan geçmiş,
provider entegrasyonları canlı doğrulanmış,
hard sandbox opsiyonu olan,
Codex-standard TUI deneyimine yaklaşmış,
subagent/MCP governance temeli tamamlanmış,
SDLC + Learning + Ship lifecycle'ı gerçek çalışan
PRD-ready agentic CLI runtime olacaktır.
```

---

## 2. Current Readiness Baseline

Mevcut değerlendirmeye göre Nexus şu seviyededir:

| Alan                 | Durum                              |
| -------------------- | ---------------------------------- |
| CLI command surface  | Çalışıyor                          |
| `nexus exec`         | Güçlü                              |
| JSONL event stream   | Çalışıyor                          |
| Session storage      | Çalışıyor                          |
| Context compiler     | Çalışıyor                          |
| Tool Bus             | Ciddi MVP seviyesinde              |
| Approval policy      | Temel olarak çalışıyor             |
| Protected paths      | Çalışıyor                          |
| Network policy       | Temel/regex tabanlı                |
| Secrets redaction    | Kısmen/iyi                         |
| SDLC Plane           | MVP seviyesinde                    |
| Learning Plane       | MVP seviyesinde                    |
| TUI                  | Var ama polish eksik               |
| Subagent             | Stub/placeholder seviyesinde       |
| MCP                  | Temel var, governance eksik        |
| Provider layer       | Adapter var, live validation eksik |
| Hard sandbox         | Eksik                              |
| Ship stage           | Zayıf                              |
| Real repo validation | Eksik                              |
| Product eval metrics | Eksik                              |

Bu plan, mevcut MVP'yi bozmadan yukarıdaki açıkları sistematik olarak kapatır.

---

## 3. Target Definition: PRD-Ready Nexus

Nexus CLI şu şartları sağladığında PRD-ready kabul edilir:

```text
1. Hard sandbox gerektiren profillerde gerçek container/OS isolation vardır.
2. Hard sandbox yoksa fail-closed davranış garanti edilir.
3. TUI, günlük kullanımda Codex-style terminal agent beklentisini karşılar.
4. /plan, /diff, /review, /status, /memories, /agent, /mcp kullanılabilir ve stabil çalışır.
5. En az bir provider canlı smoke testlerden geçmiştir.
6. Provider error, timeout, auth, rate-limit ve tool-call normalization testleri vardır.
7. Subagent sistemi gerçek ayrı thread/context/permission profile ile çalışır.
8. MCP tool çağrıları governance, allowlist, manifest ve audit altındadır.
9. Learning Plane secret-safe, scope-aware, edit/delete destekli ve ölçülebilir hale gelir.
10. Ship stage PR summary, changelog, release note ve rollback note üretir.
11. 20+ real repository dogfooding session tamamlanmıştır.
12. 100+ private beta session için ölçüm altyapısı hazırdır.
13. Eval harness yalnızca teknik test değil, product-quality metrikleri de ölçer.
14. Package release safety gate source map, secret, local state ve tarball içerik kontrolü yapar.
15. Documentation, CLI reference ve security model external tester seviyesinde tamamlanmıştır.
```

---

## 4. Implementation Principles

### 4.1 Preserve Existing Working MVP

Mevcut çalışan runtime korunmalıdır. Büyük rewrite yapılmamalıdır.

Doğru yaklaşım:

```text
extend
stabilize
harden
instrument
validate
```

Yanlış yaklaşım:

```text
rewrite everything
replace runtime core
change CLI UX standard
break existing exec behavior
```

---

### 4.2 TypeScript-Only Application Code

Nexus-owned application code TypeScript kalacaktır.

Hard sandbox için external system primitive kullanılabilir:

```text
Docker
Podman
OS-level sandbox tool
container runtime
```

Ama orchestration, policy, config, adapter ve event logic TypeScript olacaktır.

---

### 4.3 Security Before Autonomy

Agent daha akıllı hale gelirken güvenlik gevşetilmemelidir.

```text
No model direct execution
No direct filesystem mutation
No silent permission escalation
No protected path write by default
No unredacted secret in logs
No memory write without policy
```

---

### 4.4 Familiar UX, Deeper Runtime

Kullanıcı yüzeyi Codex-style kalmalıdır:

```bash
nexus
nexus exec
/plan
/diff
/review
/status
/memories
/agent
/mcp
```

Yeni özellikler ayrı karmaşık CLI komutları olarak değil, mevcut TUI/slash mental modelinin içine yerleşmelidir.

---

### 4.5 Evidence-Based Readiness

Her readiness iddiası kanıtla desteklenmelidir:

```text
test result
eval result
real repo session report
provider smoke result
security fixture result
release verification artifact
```

“Çalışıyor gibi” kabul edilmemelidir.

---

## 5. Workstream Overview

Kalan açıklar 10 workstream altında kapatılacaktır.

| Workstream | Name                                          | Priority |
| ---------: | --------------------------------------------- | -------- |
|        WS1 | Hard Sandbox & Security Hardening             | P0       |
|        WS2 | Provider Production Validation                | P0       |
|        WS3 | TUI/UX Codex-Standard Polish                  | P0       |
|        WS4 | Real Repository Dogfooding & Metrics          | P0       |
|        WS5 | Review, Plan and Verification Quality Upgrade | P0       |
|        WS6 | Real Subagent Runtime                         | P1       |
|        WS7 | MCP Governance                                | P1       |
|        WS8 | Learning Plane Productionization              | P1       |
|        WS9 | Ship Stage Completion                         | P1       |
|       WS10 | Eval, Release and Documentation Readiness     | P0/P1    |

---

## 6. Milestone Overview

| Milestone | Name                     | Goal                                                                           |
| --------: | ------------------------ | ------------------------------------------------------------------------------ |
|        M1 | Security Closure         | Hard sandbox adapter, fail-closed enforcement, stronger shell/network controls |
|        M2 | Provider Closure         | OpenAI/DeepSeek live smoke validation, provider matrix, error normalization    |
|        M3 | TUI Closure              | Codex-standard TUI polish for diff, approval, status, process, memory          |
|        M4 | SDLC Quality Closure     | Plan/review/verify intelligence upgrades                                       |
|        M5 | Subagent Runtime         | Real isolated subagents with context and permission profiles                   |
|        M6 | MCP Governance           | Manifest, allowlist, local/remote distinction, version pinning, policy         |
|        M7 | Learning Plane Hardening | Better candidates, source evidence, false-positive metrics, memory audit       |
|        M8 | Ship Stage               | PR summary, changelog, release note, rollback note, artifact schema            |
|        M9 | Real Repo Validation     | 20+ dogfooding sessions and quality dashboard                                  |
|       M10 | Beta Readiness           | 100+ session measurement framework, docs, package safety, release gates        |

---

# PART I — P0 CLOSURE WORK

---

## 7. M1 — Hard Sandbox & Security Closure

### 7.1 Problem

Mevcut sandbox TypeScript-level guard seviyesindedir. Bu MVP için kabul edilebilir olsa da production-grade agentic CLI için yeterli değildir.

Eksik:

```text
real OS/container isolation
hard network-off enforcement
filesystem mount isolation
resource limits
fail-closed hard sandbox behavior
```

### 7.2 Goal

Hard sandbox gerektiren profillerde gerçek container/OS isolation sağlamak.

Minimum production target:

```text
ContainerSandboxAdapter
  Docker/Podman supported
  workspace bind mount
  read-only and workspace-write modes
  network disabled by default
  env allowlist
  timeout
  stdout/stderr limit
  CPU/memory limit if supported
  fail-closed when unavailable
```

---

## 7.3 Implementation Tasks

### 7.3.1 Add Sandbox Capability Detection

Package:

```text
packages/sandbox
```

Implement:

```ts
export interface SandboxCapability {
  adapterId: string;
  platform: NodeJS.Platform;
  supportsReadOnly: boolean;
  supportsWorkspaceWrite: boolean;
  supportsNetworkOff: boolean;
  supportsResourceLimits: boolean;
  available: boolean;
  reasonIfUnavailable?: string;
}
```

Add detection:

```text
docker available
podman available
platform supported
current user can run container
workspace mount possible
network none supported
```

Acceptance:

```text
nexus sandbox doctor
```

prints:

```text
Sandbox capabilities:
- typescript-guard: available
- docker-container: available/unavailable
- podman-container: available/unavailable
Hard sandbox: available/unavailable
```

---

### 7.3.2 Implement `ContainerSandboxAdapter`

Package:

```text
packages/sandbox/src/adapters/container-sandbox.ts
```

Interface:

```ts
export interface ContainerSandboxConfig {
  runtime: "docker" | "podman";
  image: string;
  workspacePath: string;
  mode: "read-only" | "workspace-write";
  network: "none" | "restricted" | "host";
  envAllowlist: string[];
  timeoutMs: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}
```

Behavior:

```text
read-only:
  mount workspace read-only

workspace-write:
  mount workspace read-write
  still block protected paths via Tool Bus path guard

network none:
  run container with network disabled

env:
  pass only allowlisted env vars

cwd:
  set working directory inside mounted workspace
```

Example internal container command shape:

```text
docker run --rm
  --network none
  --memory 1g
  --cpus 2
  -v /repo:/workspace:ro|rw
  -w /workspace
  <image>
  sh -lc "<command>"
```

Acceptance:

```text
1. read-only container denies file writes
2. workspace-write container allows normal repo writes
3. network none blocks curl/wget
4. env only includes allowlisted variables
5. timeout kills long-running process
6. output limit is enforced
7. missing Docker/Podman causes hard sandbox unavailable
```

---

### 7.3.3 Add Hard Sandbox Policy

Config:

```toml
[sandbox]
require_hard_sandbox = true
preferred_adapter = "container"
container_runtime = "docker"
container_image = "node:22-bookworm-slim"
network_default = "off"
```

Policy rule:

```text
if require_hard_sandbox=true
  and no hard sandbox adapter available
    deny execution
    emit sandbox.unavailable
    fail closed
```

Event:

```json
{
  "type": "sandbox.unavailable",
  "required": true,
  "requestedMode": "workspace-write",
  "reason": "Docker or Podman not available"
}
```

Acceptance:

```text
require_hard_sandbox=true + no adapter = deny
require_hard_sandbox=false + no adapter = TypeScript guard allowed with warning
hard sandbox available = use adapter
```

---

### 7.3.4 Strengthen Network Policy

Current network policy is regex/basic. Strengthen it.

Add:

```ts
export interface NetworkPolicy {
  default: "off" | "restricted" | "on";
  allowedHosts: string[];
  blockedHosts: string[];
  allowModelProviderCalls: boolean;
  allowMcpRemoteCalls: boolean;
  allowShellNetwork: boolean;
}
```

Distinguish:

```text
model provider API calls
shell command network
MCP remote network
web/docs search
package install network
```

Acceptance:

```text
model API call can be allowed while shell network is blocked
MCP remote call requires allowlist
package install command requires approval
curl/wget denied under network off
container network none enforces hard block
```

---

### 7.3.5 Expand Command Risk Classifier

Add explicit detection categories:

```text
destructive filesystem
credential access
network exfiltration
download-and-execute
privilege escalation
package install
production deploy
destructive git
environment dump
process kill
system mutation
```

Example:

```ts
export interface CommandRiskResult {
  level: "low" | "medium" | "high" | "critical";
  categories: CommandRiskCategory[];
  reasons: string[];
  requiresApproval: boolean;
  denyByDefault: boolean;
}
```

Acceptance:

```text
rm -rf → critical
curl | bash → critical
cat .env → high/critical
printenv → high
git reset --hard → high
npm install → medium/high depending policy
npm test → low/medium
pnpm typecheck → low
```

---

### 7.3.6 Security Fixture Expansion

Create fixtures:

```text
fixtures/security/
  path-traversal/
  symlink-escape/
  protected-env/
  private-key/
  network-exfil/
  curl-bash/
  destructive-git/
  prompt-injection-readme/
  secret-in-output/
```

Required tests:

```bash
pnpm test:security
```

Acceptance:

```text
all security fixtures pass
no unredacted secrets in event logs
all denied actions produce explainable event
```

---

## 7.4 M1 Done Criteria

M1 is complete when:

```text
ContainerSandboxAdapter implemented
nexus sandbox doctor works
require_hard_sandbox fail-closed works
network policy distinguishes provider/shell/MCP
command risk classifier expanded
security fixtures pass
security docs updated
```

---

# 8. M2 — Provider Production Validation

## 8.1 Problem

Provider abstraction exists, but production-grade live validation is missing. OpenAI and DeepSeek adapters are present, but live smoke tests have not fully proven:

```text
auth
streaming
tool call normalization
error handling
timeout
rate-limit
secret redaction
JSONL event integrity
```

## 8.2 Goal

At least one primary provider must be production-validated. Secondary providers must have contract tests and optional live smoke tests.

---

## 8.3 Provider Test Matrix

Create provider smoke test suite.

Command:

```bash
pnpm provider:smoke --provider openai
pnpm provider:smoke --provider deepseek
pnpm provider:smoke --all
```

Test cases:

| Test                 | Purpose                      |
| -------------------- | ---------------------------- |
| simple_text          | Basic response               |
| streaming_text       | Streaming response           |
| tool_call_file_read  | Tool call normalization      |
| tool_call_shell_safe | Shell command proposal       |
| auth_error           | Invalid/missing key handling |
| timeout              | Timeout handling             |
| rate_limit           | Rate-limit normalization     |
| malformed_response   | Robust parser behavior       |
| jsonl_integrity      | Event stream correctness     |
| redaction            | No API key in logs           |

---

## 8.4 Provider Smoke Test Schema

```ts
export interface ProviderSmokeCase {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  expectedCapabilities: ProviderCapability[];
  requiresLiveKey: boolean;
  timeoutMs: number;
  assertions: ProviderSmokeAssertion[];
}
```

Result:

```ts
export interface ProviderSmokeResult {
  provider: string;
  model: string;
  caseId: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
  eventsPath?: string;
}
```

Output path:

```text
.nexus/provider-smoke/<provider>/<timestamp>/
  results.json
  events.jsonl
  redaction-check.json
```

---

## 8.5 Provider Contract Tests

Even without live keys, every provider must pass contract tests using mocked API responses.

Required:

```text
normal response
stream response
tool call response
refusal/error response
auth error response
rate limit response
timeout
malformed JSON
```

Acceptance:

```text
pnpm test:providers
```

passes without live keys.

---

## 8.6 Provider Error Normalization

Normalize provider errors:

```ts
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_request"
  | "model_unavailable"
  | "malformed_response"
  | "unknown";
```

User-facing error must be actionable:

```text
Provider auth failed.
Set OPENAI_API_KEY or run nexus login.
```

Not acceptable:

```text
Unhandled AxiosError: 401...
```

---

## 8.7 Provider Event Requirements

Every provider call emits:

```text
model.call.started
model.call.completed
model.call.failed
model.stream.delta
model.usage
```

Never log:

```text
API key
Authorization header
raw secret-bearing request body
```

---

## 8.8 M2 Done Criteria

M2 is complete when:

```text
OpenAI live smoke passes or selected primary provider passes
DeepSeek live smoke available and skips cleanly without key
provider contract tests pass
provider errors normalized
provider events redacted
exec mode works with live provider
interactive mode works with live provider
provider docs updated
```

---

# 9. M3 — TUI/UX Codex-Standard Polish

## 9.1 Problem

TUI exists but market-standard polish is incomplete. For a Codex-style CLI, TUI must feel stable, readable, fast and predictable.

Current gaps:

```text
diff UX limited
review UX limited
memory UX limited
approval cards need polish
process control incomplete
long-session transcript ergonomics weak
slash command parity incomplete
status line not rich enough
```

## 9.2 Goal

Make Nexus TUI trusted-alpha quality.

---

## 9.3 TUI Feature Requirements

### 9.3.1 Transcript Cards

Implement structured cards:

```text
UserMessageCard
AssistantMessageCard
PlanCard
ToolCallCard
ShellCommandCard
FileChangeCard
DiffCard
VerificationCard
ReviewCard
ApprovalCard
LearningCandidateCard
ErrorCard
```

Each card must support:

```text
collapsed view
expanded view
copy action
event id display in debug mode
timestamp optional
```

---

### 9.3.2 Diff Viewer Upgrade

Slash command:

```text
/diff
```

Required behavior:

```text
show changed files
show additions/deletions summary
open file-level diff
collapse large diff
highlight protected path changes
show checkpoint/rollback availability
```

Acceptance:

```text
/diff shows current working tree diff
/diff works after file.write
/diff works after patch.apply
large diff is not unreadable
protected path changes are visually marked
```

---

### 9.3.3 Approval Card Upgrade

Approval card must show:

```text
tool name
requested action
command/path
risk level
risk reasons
sandbox mode
network policy
protected path status
approval scope options
```

Actions:

```text
approve once
approve for session
deny
show details
copy command
```

Acceptance:

```text
high-risk command approval clearly explains risk
protected path write clearly explains risk
approval decision emits event
denial gracefully returns control to agent
```

---

### 9.3.4 Status Line Upgrade

Status line fields:

```text
model
provider
sandbox
approval policy
network policy
git branch
token/context usage
SDLC stage
Learning mode
active tool count
background process count
session id
```

Example:

```text
gpt-5.5/openai | sandbox:container workspace-write | approval:on-request | net:off | branch:feature/auth | SDLC:Verify | learning:suggest
```

Acceptance:

```text
/status and status line show same effective runtime state
changes update live
debug status shows config source
```

---

### 9.3.5 Process Control

Slash commands:

```text
/ps
/stop
```

Required:

```text
show active shell commands
show background processes
show running tool calls
allow stop by id
emit process stopped event
```

Acceptance:

```text
long-running command appears in /ps
/stop terminates running process
timeout also terminates process
TUI remains responsive
```

---

### 9.3.6 Memory Panel

Slash command:

```text
/memories
```

Required:

```text
list pending learning candidates
show accepted project memory
show accepted user memory
accept candidate
edit candidate
reject candidate
delete memory
show source events
show sensitivity status
```

Acceptance:

```text
candidate can be accepted from TUI
candidate can be edited before save
memory can be deleted
secret candidate is blocked/redacted
```

---

### 9.3.7 Slash Command Completion

Must support:

```text
/model
/fast
/permissions
/approve
/status
/debug-config
/statusline
/theme
/raw
/copy
/plan
/goal
/compact
/mention
/init
/memories
/skills
/diff
/review
/clear
/new
/resume
/fork
/side
/agent
/mcp
/apps
/plugins
/hooks
/experimental
/ps
/stop
/sandbox-add-read-dir
/keymap
/vim
/quit
/exit
/logout
```

Not all must be fully implemented, but every command must have one of:

```text
implemented
explicitly disabled with reason
planned with clear message
```

No silent no-op allowed.

---

## 9.4 TUI Testing

Add:

```bash
pnpm test:tui
```

Test cases:

```text
renders empty session
renders user/assistant message
renders tool call card
renders approval card
approval interaction works
slash palette opens
/status works
/diff renders changed file
/memories renders candidate
/ps renders running process
long output collapses
```

---

## 9.5 M3 Done Criteria

M3 is complete when:

```text
TUI supports polished transcript cards
/diff is usable
approval card is risk-aware
/status is complete
/ps and /stop work
/memories is usable
slash commands have explicit behavior
TUI tests pass
long-running sessions remain readable
```

---

# 10. M4 — Plan, Review and Verification Quality Closure

## 10.1 Problem

Plan and review exist but quality is partially deterministic and heuristic. For trusted alpha/private beta, Nexus must generate more reliable plans, better review findings and stronger verification loops.

## 10.2 Goal

Upgrade SDLC quality from “works” to “trusted”.

---

## 10.3 Structured Plan Upgrade

Plan must include:

```ts
export interface Plan {
  id: PlanId;
  goal: string;
  summary: string;
  steps: PlanStep[];
  affectedAreas: AffectedArea[];
  risks: PlanRisk[];
  requiredPermissions: PermissionRequirement[];
  verificationPlan: VerificationCommand[];
  rollbackStrategy?: string;
  definitionOfDone: DefinitionOfDoneItem[];
}
```

Add plan quality checks:

```text
has clear goal
has ordered steps
has affected files/areas
has verification
has risk notes
has rollback note for mutating tasks
has no direct unsafe command
```

Acceptance:

```text
/plan for code change always includes verification
/plan for security-sensitive change includes review requirement
/plan for mutating task includes required permissions
```

---

## 10.4 Review Engine Upgrade

Review sources:

```text
current diff
changed files
AGENTS.md
project memory
verification result
security policy
protected path list
known failure patterns
```

Review categories:

```text
correctness
missing tests
security
performance
breaking change
migration risk
style/convention
unnecessary change
rollback risk
secret exposure
```

Finding shape:

```ts
export interface ReviewFinding {
  id: string;
  category: ReviewCategory;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  file?: string;
  line?: number;
  evidence?: string;
  recommendation?: string;
  blocking: boolean;
}
```

Acceptance:

```text
/review outputs structured findings
critical findings can block success if policy requires
review report saved to review.json
review summary appears in final answer
```

---

## 10.5 Verification Upgrade

Verification command detection priority:

```text
1. explicit user command
2. AGENTS.md instruction
3. package.json scripts
4. project memory test-map
5. detected framework convention
6. model suggestion
```

Verification result:

```ts
export interface VerificationResult {
  status: "passed" | "failed" | "skipped";
  required: boolean;
  commands: CommandVerificationResult[];
  summary: string;
  failureAnalysis?: string;
  evidenceEventIds: EventId[];
}
```

Acceptance:

```text
test/lint/typecheck commands are detected
verification failure updates DoD
non-interactive required verification failure exits 6
verification report saved
```

---

## 10.6 M4 Done Criteria

M4 is complete when:

```text
plans are structured and verifiable
review findings are categorized and severity-ranked
verification command detection is reliable
DoD updates from verification/review
review can block final success by policy
evals measure plan/review quality
```

---

# 11. M5 — Real Repository Dogfooding & Metrics

## 11.1 Problem

Unit/integration tests pass, but real repository validation is missing. PRD alpha/private beta criteria require evidence from real sessions.

## 11.2 Goal

Run controlled real-repo validation and collect product metrics.

---

## 11.3 Dogfooding Session Definition

A valid real repo session must include at least one of:

```text
repo analysis
plan generation
file edit
test/verification
diff review
learning candidate
exec mode run
```

Each session must produce:

```text
events.jsonl
manifest.json
final answer
changed files list
commands run list
verification result
review result if applicable
learning candidates if applicable
user rating
```

---

## 11.4 Session Metrics

Track:

```text
task type
repo type
provider/model
sandbox mode
approval policy
plan accepted
patch accepted
verification passed
review findings
rollback used
learning candidates accepted
time to first plan
time to final answer
tool calls count
errors count
user rating
```

Metric schema:

```ts
export interface DogfoodSessionMetric {
  sessionId: string;
  repoType: string;
  taskType: string;
  provider: string;
  model: string;
  sandboxMode: string;
  planAccepted: boolean;
  patchAccepted?: boolean;
  verificationStatus?: string;
  reviewStatus?: string;
  learningAcceptedCount: number;
  errorsCount: number;
  userRating?: 1 | 2 | 3 | 4 | 5;
}
```

---

## 11.5 Dogfooding Targets

Alpha readiness:

```text
20 real repo sessions
0 unrecoverable file corruption
0 unredacted secret leaks
80% valid event logs
70% useful plan rating
50% accepted patch rate on scoped tasks
rollback success in all tested rollback cases
```

Private beta readiness:

```text
100 real repo sessions
0 P0 security issue
75% useful plan rating
60% accepted patch rate on scoped tasks
80% successful exec runs
90% JSONL event validity
memory false positive measured
provider error rate measured
```

---

## 11.6 Dogfooding Commands

Add:

```bash
pnpm dogfood:init
pnpm dogfood:report
pnpm dogfood:validate-session <session-id>
```

Reports:

```text
.nexus/dogfood/report.json
.nexus/dogfood/report.md
```

---

## 11.7 M5 Done Criteria

M5 is complete when:

```text
20+ real repo sessions completed
dogfood metrics collected
dogfood report generated
critical issues triaged
no P0 safety issue remains
alpha readiness decision can be evidence-based
```

---

# PART II — P1 CLOSURE WORK

---

# 12. M6 — Real Subagent Runtime

## 12.1 Problem

Subagent currently behaves like stub/placeholder. PRD requires real subagents with isolated context, thread, permission profile and event logging.

## 12.2 Goal

Implement real subagent runtime.

---

## 12.3 Subagent Requirements

Each subagent must have:

```text
role
thread id
isolated context
separate token budget
permission profile
tool access policy
event namespace
summary return
status
```

Subagent roles:

```text
Explorer Agent
Architect Agent
Coder Agent
Tester Agent
Reviewer Agent
Security Agent
Docs Agent
Release Agent
Learning Agent
```

---

## 12.4 Subagent Interface

```ts
export interface SubagentDefinition {
  id: string;
  name: string;
  role: SubagentRole;
  defaultModel?: string;
  permissionProfile: string;
  contextPolicy: SubagentContextPolicy;
  allowedTools: string[];
}

export interface SubagentRunInput {
  parentSessionId: SessionId;
  parentThreadId: ThreadId;
  subagentId: string;
  task: string;
  inheritedContext: ContextSlice[];
}

export interface SubagentRunResult {
  subagentThreadId: ThreadId;
  status: "completed" | "failed" | "cancelled";
  summary: string;
  findings?: unknown[];
  evidenceEventIds: EventId[];
}
```

---

## 12.5 `/agent` TUI

`/agent` must show:

```text
Main Thread
Explorer Agent
Architect Agent
Coder Agent
Tester Agent
Reviewer Agent
Security Agent
Docs Agent
Learning Agent
```

Actions:

```text
start subagent task
view running subagents
open subagent summary
stop subagent
merge summary into main thread
```

---

## 12.6 Subagent Isolation Rules

```text
Subagent cannot directly mutate main thread context.
Subagent cannot exceed its permission profile.
Subagent cannot write memory unless Learning Agent or policy allows.
Subagent returns summary by default, not full transcript.
Subagent event log must be traceable.
```

---

## 12.7 Acceptance Criteria

```text
/agent opens subagent manager
Explorer Agent can analyze repo area and return summary
Reviewer Agent can review diff and return findings
Security Agent can run with read-only permission profile
Subagent events include parent session/thread references
Subagent cannot use tools outside permission profile
Subagent summary appears in main transcript
```

---

# 13. M7 — MCP Governance

## 13.1 Problem

MCP integration exists but governance is incomplete.

Missing:

```text
local/remote distinction
manifest discovery
tool permission model
registry governance
version pinning
signed/plugin security
audit detail
```

## 13.2 Goal

Make MCP safe enough for trusted alpha/private beta.

---

## 13.3 MCP Server Manifest

Add manifest:

```ts
export interface McpServerManifest {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  version?: string;
  trustLevel: "untrusted" | "trusted" | "workspace" | "organization";
  allowedTools: string[];
  requiredPermissions: PermissionRequirement[];
  envAllowlist: string[];
  networkPolicy?: NetworkPolicy;
  pinnedHash?: string;
}
```

---

## 13.4 MCP Governance Config

```toml
[mcp]
enabled = true
allow_remote = false
require_allowlist = true
require_version_pin = true

[[mcp.servers]]
id = "local-docs"
transport = "stdio"
command = "node"
args = ["./tools/mcp-docs.js"]
trust_level = "workspace"
allowed_tools = ["search_docs"]
```

---

## 13.5 MCP Policy Rules

```text
remote MCP disabled by default
unlisted MCP server denied
tool not in allowedTools denied
env passed only from envAllowlist
remote MCP requires network policy
MCP tool calls emit audit events
```

---

## 13.6 MCP Events

Emit:

```text
mcp.server.added
mcp.server.removed
mcp.server.started
mcp.server.failed
mcp.tool.discovered
mcp.tool.requested
mcp.tool.completed
mcp.tool.denied
```

---

## 13.7 Acceptance Criteria

```text
nexus mcp list shows local/remote status
/mcp shows server trust level
unallowlisted MCP tool denied
remote MCP denied by default
version pin warning shown if missing
MCP tool calls go through Tool Bus policy
MCP audit events written
```

---

# 14. M8 — Learning Plane Productionization

## 14.1 Problem

Learning Plane works at MVP level but lacks enough quality control, measurement and workflow intelligence.

## 14.2 Goal

Make Learning Plane reliable, safe, measurable and useful.

---

## 14.3 Candidate Evidence Upgrade

Each candidate must include:

```text
source event ids
confidence reason
scope
sensitivity status
conflict status
storage target
```

Shape:

```ts
export interface LearningCandidateEvidence {
  sourceEventIds: EventId[];
  observedCount: number;
  explicitUserStatement: boolean;
  supportedByConfig: boolean;
  supportedBySuccessfulCommand: boolean;
  conflictsWithAgentsMd: boolean;
  conflictsWithPolicy: boolean;
}
```

---

## 14.4 False Positive Tracking

Track candidate outcomes:

```text
accepted
edited
rejected
deleted_later
conflicted
blocked_sensitive
```

Metric:

```ts
export interface LearningQualityMetric {
  candidateType: string;
  generated: number;
  accepted: number;
  edited: number;
  rejected: number;
  deletedLater: number;
  falsePositiveRate: number;
}
```

---

## 14.5 Workflow Learning

Detect repeated workflows:

```text
CI triage
test failure fix
release notes
dependency upgrade
security review
PR review
typecheck/lint/test sequence
```

Workflow memory example:

```json
{
  "id": "workflow_ci_triage",
  "name": "CI failure triage",
  "steps": [
    "read failing log",
    "run pnpm typecheck",
    "run targeted test",
    "inspect changed files",
    "produce minimal patch"
  ],
  "confidence": 0.82
}
```

---

## 14.6 Active Mode Clarification

Current `active` behaves like `suggest`. Define final behavior:

```text
off:
  no learning

observe:
  collect events, no candidates shown by default

suggest:
  candidates shown, explicit approval required

active:
  low-risk project facts may be written automatically only in trusted project
  all user preference and sensitive candidates still require approval
```

Config:

```toml
[learning.active_policy]
auto_write_low_risk_project_facts = true
auto_write_test_commands = true
auto_write_user_preferences = false
auto_write_security_rules = false
```

---

## 14.7 Memory Audit

Add:

```bash
nexus memories list
nexus memories delete <id>
nexus memories export
nexus memories audit
```

TUI:

```text
/memories
```

must show:

```text
memory id
scope
created at
source event
confidence
last used
delete/edit actions
```

---

## 14.8 Acceptance Criteria

```text
candidate evidence is visible
candidate false positive metrics collected
active mode semantics implemented or explicitly disabled
workflow memory generated from repeated sessions
memory audit/export/delete works
secret candidates are blocked
memory injection respects priority and scope
```

---

# 15. M9 — Ship Stage Completion

## 15.1 Problem

PRD expects Ship stage outputs, but current implementation is weak.

Missing:

```text
PR summary
release note
changelog
rollback note
risk summary
test summary
ship artifact schema
```

## 15.2 Goal

Implement real Ship stage.

---

## 15.3 Ship Artifact Schema

```ts
export interface ShipArtifact {
  id: string;
  sessionId: SessionId;
  createdAt: string;
  commitMessage?: string;
  prTitle?: string;
  prDescription?: string;
  changelog?: string;
  releaseNotes?: string;
  testSummary?: string;
  riskSummary?: string;
  rollbackNote?: string;
  changedFiles: string[];
  verificationStatus?: string;
  reviewStatus?: string;
}
```

Write to:

```text
.nexus/runs/<session-id>/ship.json
.nexus/runs/<session-id>/ship.md
```

---

## 15.4 `/ship` Slash Command

Add slash command:

```text
/ship
```

Behavior:

```text
collect diff
collect verification report
collect review report
collect changed files
generate PR summary
generate commit message
generate changelog
generate rollback note
save ship artifact
```

---

## 15.5 Ship Output Template

PR description:

```md
## Summary

## Changes

## Tests

## Risks

## Rollback Plan

## Nexus Verification

## Review Findings
```

Commit message:

```text
type(scope): concise summary
```

Release note:

```md
### Added

### Changed

### Fixed

### Risks
```

---

## 15.6 Acceptance Criteria

```text
/ship generates ship.md
ship artifact includes changed files
ship artifact includes verification status
ship artifact includes review findings
ship artifact includes rollback note
non-interactive mode can output ship artifact
```

---

# PART III — EVAL, RELEASE AND BETA READINESS

---

# 16. M10 — Eval Harness Expansion

## 16.1 Problem

Current eval/release readiness is technical but does not fully measure product quality.

## 16.2 Goal

Add evals for actual agent quality.

---

## 16.3 Eval Dimensions

Measure:

```text
task success
plan usefulness
diff minimality
test pass
unnecessary file changes
review quality
security compliance
sandbox compliance
memory quality
provider reliability
TUI intent behavior
exec JSONL correctness
rollback success
ship artifact quality
```

---

## 16.4 Eval Case Schema

```ts
export interface NexusEvalCase {
  id: string;
  name: string;
  fixtureRepo: string;
  prompt: string;
  mode: "interactive-simulated" | "exec";
  sandboxMode: string;
  provider: "fake" | "live";
  expected: {
    filesChanged?: string[];
    forbiddenFilesChanged?: string[];
    commandsRun?: string[];
    events?: string[];
    exitCode?: number;
    verificationStatus?: string;
    reviewFindings?: string[];
    memoryCandidates?: string[];
  };
}
```

---

## 16.5 Required Eval Suites

```text
eval:baseline
eval:security
eval:provider
eval:exec
eval:tui-intents
eval:sdlc
eval:learning
eval:subagents
eval:mcp
eval:ship
eval:real-repo
```

---

## 16.6 Quality Thresholds

Alpha:

```text
baseline eval pass >= 90%
security eval pass = 100%
exec JSONL validity = 100%
rollback eval pass = 100%
```

Private beta:

```text
baseline eval pass >= 95%
security eval pass = 100%
provider smoke pass >= 90%
review useful rating >= 70%
learning false positive <= 25%
```

v1:

```text
baseline eval pass >= 98%
security eval pass = 100%
provider smoke pass >= 95%
real-repo accepted patch >= 60%
unnecessary file modification <= 10%
secret leak = 0
```

---

## 16.7 Acceptance Criteria

```text
eval suites can run locally
CI runs baseline/security/exec evals
provider evals run when keys available
real-repo report can be generated
eval results written as JSON and Markdown
```

---

# 17. Release Safety Completion

## 17.1 Problem

Release verification exists but must be strengthened to prevent package leaks, source maps, local state and secrets.

## 17.2 Goal

Production-grade release gate.

---

## 17.3 Release Verification Command

```bash
pnpm verify:release
```

Must run:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm eval:baseline
pnpm eval:security
pnpm verify:package
pnpm verify:sourcemaps
pnpm verify:secrets
pnpm verify:tarball
```

---

## 17.4 Package Verification

Check tarball for:

```text
.env
.env.*
auth.json
.nexus/
*.pem
*.key
id_rsa
source maps if disabled
test secrets
absolute local paths
large unexpected files
private fixtures
```

Output:

```text
release-verification.json
release-verification.md
```

---

## 17.5 Source Map Policy

Config:

```toml
[release]
publish_source_maps = false
```

Rule:

```text
if publish_source_maps=false and tarball contains .map:
  fail release
```

---

## 17.6 Acceptance Criteria

```text
release verification fails on injected .env
release verification fails on source map when disabled
release verification fails on private key fixture
release verification passes clean package
release report generated
```

---

# 18. Documentation Completion

## 18.1 Required Docs

Create/update:

```text
docs/getting-started.md
docs/cli-reference.md
docs/slash-commands.md
docs/non-interactive.md
docs/configuration.md
docs/security.md
docs/sandbox.md
docs/providers.md
docs/mcp.md
docs/subagents.md
docs/learning-plane.md
docs/agentic-sdlc.md
docs/ship-stage.md
docs/evals.md
docs/release-safety.md
docs/troubleshooting.md
```

---

## 18.2 Security Docs Must Explain

```text
sandbox modes
hard sandbox availability
fail-closed behavior
approval policies
protected paths
network policy
secret redaction
MCP risks
danger mode warning
```

---

## 18.3 User Docs Must Include

```text
install
login/provider config
nexus interactive usage
nexus exec usage
slash commands
plan/diff/review flow
memory approval
session resume
common errors
```

---

## 18.4 Acceptance Criteria

```text
new user can install and run Nexus
tester can configure provider
tester can understand sandbox limitations
tester can run exec in CI
tester can disable learning
tester can inspect/delete memory
tester can interpret JSONL events
```

---

# 19. Acceptance Gates

## 19.1 Alpha Gate

Nexus is Alpha-ready when:

```text
M1 security closure done
M2 primary provider live smoke done
M3 TUI closure mostly done
M4 plan/review/verification quality improved
M5 20 real repo sessions completed
baseline/security/exec evals pass
release verification passes
docs for internal testers complete
```

Alpha required metrics:

```text
real repo sessions >= 20
unrecoverable file corruption = 0
secret leak = 0
security eval pass = 100%
JSONL validity = 100%
useful plan rating >= 70%
accepted patch rate >= 50%
```

---

## 19.2 Private Beta Gate

Nexus is Private Beta-ready when:

```text
hard sandbox available or clearly documented fail-closed
provider smoke matrix stable
TUI long-session UX stable
subagent runtime MVP complete
MCP governance MVP complete
Learning Plane quality metrics available
Ship stage complete
100 session validation framework ready
docs external-tester ready
```

Private beta required metrics:

```text
real/private sessions >= 100
P0 security issues = 0
secret leak = 0
provider smoke pass >= 90%
useful plan rating >= 75%
accepted patch rate >= 60%
exec success rate >= 80%
learning false positive measured and <= 25%
```

---

## 19.3 Public Beta Gate

Nexus is Public Beta-ready when:

```text
private beta issues triaged
hard sandbox path stable
provider errors low
TUI polish high
subagents reliable
MCP governance reliable
docs complete
install/update stable
release safety automated
```

Public beta required metrics:

```text
P0 issues = 0
P1 unresolved issues acceptable and documented
baseline eval >= 95%
security eval = 100%
provider smoke >= 95%
real repo accepted patch >= 60%
unnecessary file modification <= 15%
```

---

## 19.4 v1 Gate

Nexus is v1-ready when:

```text
production security baseline satisfied
hard sandbox reliable on supported platforms
provider integration stable
event schema stable
Learning Plane safe and useful
Ship stage complete
MCP governance stable
subagent isolation stable
release process repeatable
documentation complete
```

v1 required metrics:

```text
secret leak = 0
security eval = 100%
provider smoke >= 95%
baseline eval >= 98%
rollback success = 100%
event schema compatibility maintained
real repo accepted patch >= 65%
user rating >= 4/5 in private beta cohort
```

---

# 20. Prioritized Backlog

## 20.1 P0 Backlog

```text
ContainerSandboxAdapter
sandbox doctor
require_hard_sandbox fail-closed
network policy separation
command risk classifier upgrade
security fixtures expansion
provider smoke test matrix
OpenAI live smoke
DeepSeek live smoke optional
provider contract tests
TUI approval card polish
TUI diff viewer polish
TUI status line upgrade
/ps and /stop process control
review engine upgrade
verification detection upgrade
20 real repo dogfood sessions
dogfood metrics report
release verification hardening
docs/security.md
docs/non-interactive.md
docs/provider.md
```

---

## 20.2 P1 Backlog

```text
real subagent runtime
/agent manager
subagent permission profiles
subagent event namespace
MCP manifest
MCP local/remote distinction
MCP version pinning
MCP governance config
Learning candidate evidence
Learning false-positive metrics
Workflow learning
Memory audit/export/delete
/ship command
ship artifact schema
PR summary generation
changelog generation
rollback note generation
eval:learning
eval:subagents
eval:mcp
eval:ship
external tester docs
```

---

## 20.3 P2 Backlog

```text
plugin signing
organization policy bundle
team memory
cloud sync
remote runner
hosted eval dashboard
IDE companion
browser companion
GitHub PR integration
issue tracker integration
enterprise admin console
```

---

# 21. Suggested Implementation Order

Do not implement randomly. Use this order:

```text
1. Provider smoke tests
2. Security hardening and hard sandbox
3. TUI approval/diff/status/process polish
4. Review and verification quality upgrade
5. Real repo dogfooding metrics
6. Release verification hardening
7. Subagent runtime
8. MCP governance
9. Learning Plane productionization
10. Ship stage
11. Eval expansion
12. Documentation completion
13. Private beta gate
```

Reasoning:

```text
Provider + security + TUI are immediate alpha blockers.
Subagent + MCP + Learning + Ship are private beta blockers.
Enterprise/cloud/plugin work can wait.
```

---

# 22. Concrete Sprint Plan

## Sprint 1 — Provider and Release Evidence

Goal:

```text
Prove model provider layer and package safety.
```

Tasks:

```text
provider smoke test runner
OpenAI smoke cases
DeepSeek smoke cases
provider contract tests
provider error normalization
redaction assertions
release verification strengthening
source map verification
secret verification
tarball verification
```

Demo:

```bash
pnpm provider:smoke --provider openai
pnpm verify:release
```

Done:

```text
primary provider live smoke passes
provider report generated
release gate catches injected secrets/source maps
```

---

## Sprint 2 — Hard Sandbox

Goal:

```text
Add real hard sandbox path.
```

Tasks:

```text
sandbox doctor
sandbox capability detection
ContainerSandboxAdapter
Docker/Podman detection
network none enforcement
env allowlist
resource timeout/output limit
require_hard_sandbox fail-closed
security fixtures
docs/sandbox.md
```

Demo:

```bash
nexus sandbox doctor
nexus exec --sandbox workspace-write --config sandbox.require_hard_sandbox=true "run tests"
```

Done:

```text
container sandbox runs safe command
network blocked in container
missing sandbox fails closed
```

---

## Sprint 3 — TUI Alpha Polish

Goal:

```text
Make TUI trusted-alpha usable.
```

Tasks:

```text
structured transcript cards
approval card upgrade
diff viewer upgrade
status line upgrade
/ps
/stop
/memories panel
slash command explicit states
TUI tests
```

Demo:

```bash
nexus
```

Flow:

```text
/plan
apply patch
approval card
/diff
/review
/memories
/ps
```

Done:

```text
TUI supports daily dogfooding without confusion
```

---

## Sprint 4 — Review/Verify Quality

Goal:

```text
Make SDLC outputs trustworthy.
```

Tasks:

```text
structured plan schema upgrade
verification command priority
review finding categories
review severity policy
DoD update rules
verification report upgrade
review report upgrade
eval:sdlc
```

Demo:

```text
/goal Fix failing tests with minimal diff
/plan
apply
/review
/ship
```

Done:

```text
plan, verification and review are structured and saved
```

---

## Sprint 5 — Dogfooding Metrics

Goal:

```text
Prove real repo behavior.
```

Tasks:

```text
dogfood session schema
dogfood report generator
session rating input
quality metrics
20 real repo sessions
triage P0/P1 bugs
alpha readiness report
```

Demo:

```bash
pnpm dogfood:report
```

Done:

```text
20+ real sessions documented
alpha decision evidence available
```

---

## Sprint 6 — Subagent Runtime

Goal:

```text
Replace subagent stubs with real runtime.
```

Tasks:

```text
SubagentDefinition
subagent thread manager
isolated context compiler
permission profile per subagent
subagent event namespace
/agent TUI
Explorer Agent
Reviewer Agent
Security Agent
```

Demo:

```text
/agent
Run Security Agent on current diff
```

Done:

```text
subagent returns isolated summary with event evidence
```

---

## Sprint 7 — MCP Governance

Goal:

```text
Make MCP safe.
```

Tasks:

```text
MCP manifest
MCP server registry upgrade
local/remote distinction
allowlist enforcement
tool permission model
version pinning warning
MCP events
/mcp TUI upgrade
docs/mcp.md
```

Demo:

```bash
nexus mcp list
```

Done:

```text
untrusted MCP denied by policy
allowed MCP tool call audited
```

---

## Sprint 8 — Learning and Ship

Goal:

```text
Complete advanced PRD planes.
```

Tasks:

```text
candidate evidence
false positive metrics
workflow learning
active mode semantics
memory audit/export/delete
/ship
ship artifact
PR summary
changelog
release note
rollback note
```

Demo:

```text
/compact
/memories
/ship
```

Done:

```text
Learning and Ship stage are PRD-complete for beta
```

---

# 23. Final PRD Readiness Checklist

Nexus is full PRD-ready when every item below is checked.

## 23.1 CLI and Exec

```text
[ ] nexus interactive starts reliably
[ ] nexus "prompt" starts with initial prompt
[ ] nexus exec works
[ ] nexus exec --json outputs valid JSONL only
[ ] deterministic exit codes work
[ ] artifacts flags work
[ ] session resume works
[ ] fork/side behavior is explicit
```

## 23.2 TUI

```text
[ ] transcript cards polished
[ ] approval card risk-aware
[ ] diff viewer usable
[ ] review viewer usable
[ ] memory panel usable
[ ] status line complete
[ ] /ps works
[ ] /stop works
[ ] slash commands explicit
[ ] long output collapses
```

## 23.3 Security

```text
[ ] ContainerSandboxAdapter implemented
[ ] sandbox doctor works
[ ] require_hard_sandbox fail-closed
[ ] protected path policy works
[ ] command risk classifier expanded
[ ] network policy separated
[ ] secrets scanner covers logs/memory/output
[ ] prompt injection detector tested
[ ] security fixtures pass
```

## 23.4 Providers

```text
[ ] primary provider live smoke passes
[ ] provider contract tests pass
[ ] auth errors normalized
[ ] timeout errors normalized
[ ] rate-limit errors normalized
[ ] tool call normalization tested
[ ] provider secrets not logged
```

## 23.5 SDLC

```text
[ ] discover reliable
[ ] /goal creates DoD
[ ] /plan structured
[ ] implement stage records changes
[ ] verify stage runs/detects commands
[ ] review stage structured
[ ] ship stage complete
[ ] learn stage candidate generation works
```

## 23.6 Learning

```text
[ ] candidate evidence exists
[ ] source events attached
[ ] secret candidates blocked
[ ] candidate edit/reject/delete works
[ ] memory audit works
[ ] false positive metrics collected
[ ] workflow learning works
[ ] active mode semantics defined
```

## 23.7 Subagents

```text
[ ] /agent manager works
[ ] subagent has separate thread
[ ] subagent has isolated context
[ ] subagent has permission profile
[ ] subagent events traceable
[ ] subagent summary merges to main thread
```

## 23.8 MCP

```text
[ ] MCP manifest implemented
[ ] local/remote distinction exists
[ ] allowlist enforced
[ ] tool permission enforced
[ ] env allowlist enforced
[ ] version pinning warning exists
[ ] MCP audit events written
```

## 23.9 Release and Eval

```text
[ ] baseline eval passes
[ ] security eval passes
[ ] provider eval passes
[ ] exec eval passes
[ ] learning eval passes
[ ] ship eval passes
[ ] package verification passes
[ ] source map check passes
[ ] secret check passes
[ ] tarball check passes
```

## 23.10 Real Repo Validation

```text
[ ] 20+ dogfood sessions complete
[ ] dogfood report generated
[ ] no unrecoverable file corruption
[ ] no secret leak
[ ] useful plan rating measured
[ ] accepted patch rate measured
[ ] rollback success measured
[ ] provider error rate measured
```

---

# 24. Final Definition of Done

This completion plan is done when Nexus can pass the following end-to-end scenario.

## 24.1 Interactive Scenario

Command:

```bash
cd real-project
nexus
```

User:

```text
/goal Add safe retry support to payment flow with minimal diff and tests.
/plan
```

Nexus must:

```text
load AGENTS.md
discover repo
build context
generate structured plan
show risks
show required permissions
show verification plan
wait for user approval
```

User:

```text
Apply it.
```

Nexus must:

```text
check policy
request approval
run inside sandbox
create checkpoint
apply patch
show diff
run verification
review changes
generate ship artifact
generate learning candidates
store approved memory
write event log
```

Required outputs:

```text
events.jsonl
manifest.json
diff.patch
verification.json
review.json
ship.md
learning-candidates.json
```

---

## 24.2 Non-Interactive Scenario

Command:

```bash
nexus exec --json \
  --sandbox workspace-write \
  --output final.md \
  --patch diff.patch \
  --report verification.json \
  "Review the current diff and fail if critical issues exist"
```

Nexus must:

```text
not open TUI
stream valid JSONL
respect approval policy
respect sandbox
produce review result
produce deterministic exit code
redact secrets
write artifacts
```

---

## 24.3 Security Scenario

Command:

```bash
nexus exec \
  --config sandbox.require_hard_sandbox=true \
  "Run tests"
```

If hard sandbox is available:

```text
run in hard sandbox
network off by default
write only allowed paths
```

If hard sandbox is unavailable:

```text
deny
emit sandbox.unavailable
exit with sandbox error code
```

---

## 24.4 Provider Scenario

Command:

```bash
pnpm provider:smoke --provider openai
```

Must pass:

```text
simple text
streaming
tool call
auth handling
timeout handling
redaction
JSONL integrity
```

---

## 24.5 Dogfooding Scenario

Command:

```bash
pnpm dogfood:report
```

Must show:

```text
sessions count
task types
plan acceptance
patch acceptance
verification pass rate
review findings
learning acceptance
errors
user ratings
readiness decision
```

---

# 25. Final Completion Statement

Nexus will be considered PRD-ready when the current MVP runtime is hardened across security, provider reliability, TUI quality, SDLC correctness, Learning Plane quality, subagent isolation, MCP governance, ship workflow, eval coverage and real-repository validation.

The most important transformation is:

```text
From:
  "working MVP agent runtime"

To:
  "evidence-backed, policy-driven, sandboxed, PRD-complete agentic CLI"
```

The final product must satisfy this principle:

> Nexus must not only work. It must be safe, observable, recoverable, measurable, learnable and trusted in real repositories.

This implementation plan closes the gap between current MVP and full PRD readiness.
