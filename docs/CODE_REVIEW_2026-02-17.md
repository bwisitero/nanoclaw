# NanoClaw Code Review — 2026-02-17

Six specialist reviewers examined the codebase for efficiency, cost, latency, reliability, and security improvements. This document synthesizes their findings into a single prioritized action plan.

**Reviewers**: Container Expert, Performance Engineer, AI/LLM Cost Expert, Generalist Architect, Reliability/SRE, Security Expert

---

## How to Read This Document

Findings are **deduplicated and cross-referenced** across reviewers. Where multiple reviewers flagged the same issue, the strongest framing is used and dissenting opinions noted. Each finding has:

- **Severity**: Critical / High / Medium / Low
- **Category**: Security, Reliability, Performance, Cost, Architecture
- **Effort**: Low (hours) / Medium (day) / High (days)
- **Reviewers**: Which specialists flagged it

---

## CRITICAL — Fix Before Next Deploy

### C1. Path Traversal in IPC File Sending

**Category**: Security | **Effort**: Low | **Reviewers**: Security

`src/index.ts:775-781` — The `send_file` IPC handler constructs a path with `path.join(GROUPS_DIR, groupFolder, filePath)` where `filePath` comes from container-written JSON. A container can write `../../.ssh/id_rsa` as the filePath and exfiltrate arbitrary host files via WhatsApp/Telegram.

**Fix**: Validate resolved path stays within group directory:
```typescript
const absolutePath = path.resolve(path.join(GROUPS_DIR, groupFolder, filePath));
const groupDir = path.resolve(path.join(GROUPS_DIR, groupFolder));
if (!absolutePath.startsWith(groupDir + path.sep)) {
  throw new Error('Path traversal blocked');
}
```

### C2. AWS Credentials Mounted in All Containers

**Category**: Security | **Effort**: Medium | **Reviewers**: Security

`src/container-runner.ts:226-234` — The `~/.aws` directory is mounted read-only into every container. Any non-main group's agent can `cat /home/node/.aws/credentials` via Bash tool and obtain AWS keys.

**Fix**: Remove the mount entirely. Credentials already flow via stdin (`readSecrets()`). If AWS CLI is needed inside containers, use STS temporary credentials scoped to Bedrock only.

### C3. IPC Cross-Group Skill Request Authorization

**Category**: Security | **Effort**: Low | **Reviewers**: Security

`src/ipc.ts:121-163` — Skill requests use `data.requestingChatJid` without verifying it belongs to the source group's folder. A container in groupA could craft an IPC file requesting skills on behalf of groupB.

**Fix**: Validate `registeredGroups[data.requestingChatJid]?.folder === sourceGroup` before processing skill requests.

---

## HIGH — Ship This Week

### H1. Container Cold-Start: TypeScript Recompilation Every Spawn (~1s)

**Category**: Performance | **Effort**: Low | **Reviewers**: Container, Performance

`container/Dockerfile` entrypoint runs `npx tsc --outDir /tmp/dist` on every container start. This adds 800-1200ms to every spawn. With 5 concurrent containers, that's 5 seconds of aggregate CPU wasted per cycle.

**Fix**: Pre-compile TypeScript at image build time. Add `RUN npm run build` to Dockerfile, update entrypoint to skip compilation, remove runtime `chmod -R`.

### H2. Message Loop Polling: 2-Second Floor Latency

**Category**: Performance | **Effort**: Low | **Reviewers**: Performance, Architect

`src/config.ts:4` — `POLL_INTERVAL = 2000`. Every message waits up to 2 seconds before being noticed. Average perceived latency: ~1 second of pure idle waiting.

**Fix**: Reduce to 500-750ms. The poll body (`getNewMessages`) is an indexed SQLite query that runs in <10ms.

### H3. Skill Files Copied on Every Container Spawn

**Category**: Performance | **Effort**: Low | **Reviewers**: Container, Performance

`src/container-runner.ts:236-251` — Synchronous `fs.copyFileSync` loop copies all skill files into each group's session directory on every spawn. Adds 50-150ms of blocking I/O to the hot path.

**Fix**: Mount the skills directory read-only instead of copying:
```typescript
mounts.push({
  hostPath: path.join(process.cwd(), 'container', 'skills'),
  containerPath: '/home/node/.claude/skills',
  readonly: true,
});
```
Remove the copy loop.

### H4. SQLite No Busy Timeout — Cascading Failures Under Load

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability, Architect

`src/db.ts` — WAL mode is enabled but no `busy_timeout` is set (default: 0ms). Under concurrent container activity, `SQLITE_BUSY` errors cascade through the message loop, IPC watcher, and cost recording.

**Fix**: Add after WAL pragma:
```typescript
db.pragma('busy_timeout = 5000');
```

### H5. IPC Polling: 500ms Container-Side + 1000ms Host-Side

**Category**: Performance | **Effort**: Medium | **Reviewers**: Container, Performance

Two polling loops add latency to every IPC round-trip:
- Container polls for input files every 500ms (`container/agent-runner/src/index.ts:378`)
- Host polls for IPC output files every 1000ms (`src/ipc.ts:219`)

Combined: 0-1500ms added latency per IPC message.

**Fix**: Replace polling with `fs.watch()` on both sides. Fall back to 100-250ms poll as safety net for platforms where fs.watch is unreliable.

### H6. System Prompt Bloat: 806-Line CLAUDE.md

**Category**: Cost | **Effort**: Low | **Reviewers**: AI/LLM Cost

`groups/main/CLAUDE.md` is 806 lines (~10K tokens). It's loaded on every interaction, including session resumes. 40% of it is Google Workspace documentation that's only relevant when using Gmail/Calendar tools.

**Fix**: Split into:
- `groups/main/CLAUDE.md` — Core instructions only (~150 lines, ~2K tokens)
- `groups/main/.claude/google-workspace.md` — Google integration docs (loaded on demand)
- `groups/main/.claude/admin-context.md` — Group management (loaded for admin commands)

**Savings**: ~8K tokens/interaction × 50 interactions/day = **400K tokens/day** (~$1.20/day at Sonnet).

### H7. Symlink-Based Mount Escape

**Category**: Security | **Effort**: Medium | **Reviewers**: Security

`src/mount-security.ts:138` — `realpathSync()` resolves symlinks at validation time, but symlinks created after validation (or within allowed directories) can escape the allowlist at runtime.

**Fix**: After resolving, verify the real path doesn't point to blocked locations. For non-main groups, scan mounted directories for symlinks pointing outside the mount root.

### H8. Path Traversal in Document Processor File Names

**Category**: Security | **Effort**: Low | **Reviewers**: Security

`src/document-processor.ts:36-41` — Upload file names are user-controlled (from WhatsApp/Telegram). The `displayName()` function strips a timestamp prefix but doesn't sanitize path components like `../`.

**Fix**: Strip `/`, `\`, and `..` from file names before storing in DB.

---

## MEDIUM — Ship This Sprint

### M1. Message Cursor Loss on Silent Container Exit

**Category**: Reliability | **Effort**: Medium | **Reviewers**: Reliability, Architect

`src/index.ts:202-205` — The message cursor is advanced and persisted to SQLite *before* the container runs. If the container exits cleanly (code 0) but produces no output, the cursor is never rolled back and messages are silently lost.

**Fix**: Track whether the container did meaningful work. Only persist the advanced cursor after at least one output callback fires or the container exits successfully with a session update.

### M2. ParseBuffer String Operations: O(n²) on Large Output

**Category**: Performance | **Effort**: Medium | **Reviewers**: Performance, Container

`src/container-runner.ts:494-550` — Each `data` event calls `indexOf()` + `slice()` in a while loop on the entire parseBuffer. For large outputs with many markers, this creates quadratic string allocation.

**Fix**: Use index-based tracking. Only `slice()` the buffer once at the end of each data event, not per-marker.

### M3. Embedding Service Hangs Permanently on Startup Timeout

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability

`src/embedding-client.ts:108-113` — If the embedding process hangs during startup, the 120s timeout fires and rejects, but the process is never killed. Subsequent calls see `proc && !proc.killed` and try to use the dead connection.

**Fix**: Kill the process when the startup timeout fires:
```typescript
if (proc && !proc.killed) proc.kill('SIGKILL');
```

### M4. Container Timeout Race: resetTimeout After Resolution

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability

`src/container-runner.ts:641` — `resetTimeout()` doesn't check the `resolved` guard. It can fire after both `close` and `error` handlers have already resolved, accessing stale state.

**Fix**: Add `if (resolved) return;` at the top of `resetTimeout()`.

### M5. Progress Message Chain Can Block Shutdown

**Category**: Reliability | **Effort**: Medium | **Reviewers**: Reliability

`src/index.ts:339-365` — If `channel.sendMessage` hangs (Telegram API timeout), `progressReady` never resolves, `editChain` stalls, and the `finally` block's `await editChain` blocks graceful shutdown.

**Fix**: Add timeout to the await in the finally block:
```typescript
try { await Promise.race([editChain, new Promise(r => setTimeout(r, 5000))]); } catch {}
```

### M6. Weak Task ID Entropy

**Category**: Security | **Effort**: Low | **Reviewers**: Security

`src/ipc.ts:324` — Task IDs use `Date.now()` + 6 chars of `Math.random()`, which is predictable. An attacker can enumerate and manipulate other groups' tasks.

**Fix**: Use `crypto.randomBytes(16).toString('hex')`.

### M7. GroupQueue Starvation: waitingGroups is FIFO Array

**Category**: Architecture | **Effort**: Low | **Reviewers**: Architect

`src/group-queue.ts:69-76` — `waitingGroups` is an array checked with `includes()` (O(n)) and used as a FIFO queue. Groups can get stuck if they have no work when drained.

**Fix**: Use a `Set` instead of an array. On drain, skip groups with no pending work and remove them from the set.

### M8. Document Processing Blocks Startup (Sync execFileSync)

**Category**: Performance, Reliability | **Effort**: Medium | **Reviewers**: Architect, Reliability

`src/document-processor.ts:58` — PDF extraction uses `execFileSync` with a 60-second timeout and 50MB max buffer. On startup, this runs for every group sequentially, blocking the event loop and message loop.

**Fix**: Use async `execFile` (promisified). Consider moving document indexing to a worker thread or deferring it until after the message loop starts.

### M9. Unbounded Document Processing (DoS)

**Category**: Security | **Effort**: Medium | **Reviewers**: Security

`src/document-processor.ts:313-335` — No limits on file size, chunk count, or embedding batch rate. A user can upload many large files to exhaust memory and API quota.

**Fix**: Add per-group limits: max file size (50MB), max total chunks (10K), rate limiting on embedding calls.

### M10. Cost Recorded Multiple Times Per Container

**Category**: Architecture | **Effort**: Low | **Reviewers**: Architect

`src/container-runner.ts` — Cost is recorded in three places (streaming exit, legacy exit, timeout exit). This can produce duplicate rows.

**Fix**: Record cost exactly once, after the container exits, using a single code path regardless of exit reason.

---

## LOW — Backlog

### L1. Typing Indicator Refresh Every 4s (Wasteful)

**Category**: Performance | **Effort**: Low | **Reviewers**: Performance

`src/index.ts:238` — setTyping fires every 4 seconds for the entire container lifetime. For a 30-minute run, that's ~450 API calls.

**Fix**: Only refresh while actively waiting for first output. Stop after first result.

### L2. Progress Message 2-Second Delay

**Category**: Performance | **Effort**: Low | **Reviewers**: Performance

`src/index.ts:262` — Users wait 2 seconds before seeing any visual feedback.

**Fix**: Reduce to 500-750ms.

### L3. Event Listener Leak on WhatsApp Reconnect

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability, Architect

`src/channels/whatsapp.ts:168` — Group sync `setInterval` is never cleared on disconnect. Reconnections accumulate duplicate timers.

**Fix**: Store interval ID, clear on disconnect.

### L4. IPC Watcher No Backoff on Filesystem Errors

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability

`src/ipc.ts:54-57` — On read errors, reschedules at same interval (1s). Can produce 60 error logs/minute indefinitely.

**Fix**: Exponential backoff on consecutive errors, reset on success.

### L5. Stale Group Snapshots Leak Info

**Category**: Security | **Effort**: Low | **Reviewers**: Security

`src/container-runner.ts:1017` — `available_groups.json` written for main persists on disk. A later non-main container could read stale data.

**Fix**: Delete snapshot files after container exits.

### L6. Shutdown Doesn't Wait for IPC Watcher

**Category**: Reliability | **Effort**: Low | **Reviewers**: Reliability

`src/index.ts:722-730` — IPC watcher has no stop function. On shutdown, it may be mid-write when `process.exit()` fires.

**Fix**: Add `stopIpcWatcher()` function, call it during shutdown.

### L7. Container Image Size (~300MB Optional Deps)

**Category**: Performance | **Effort**: High | **Reviewers**: Container

Dockerfile includes Chromium (~100MB), Python + packages (~50MB), build-essential (~100MB). Not all groups need all tools.

**Fix**: Long-term: create slim/browser/python image variants selected at spawn time based on group capabilities.

### L8. MAX_CONCURRENT_CONTAINERS Default (5) May Be Low

**Category**: Performance | **Effort**: Low | **Reviewers**: Container

`src/config.ts:38` — Default of 5 may underutilize host resources.

**Fix**: Default to `Math.min(os.cpus().length, 20)` or at least 10.

### L9. Scheduled Tasks Don't Reuse Sessions

**Category**: Cost | **Effort**: Medium | **Reviewers**: AI/LLM Cost

`src/task-scheduler.ts` — Each scheduled task run starts fresh context, reloading the full system prompt. A daily task wastes ~10K tokens per run on redundant context.

**Fix**: Persist per-task session IDs in the `scheduled_tasks` table. Resume sessions for recurring tasks.

### L10. No Structured Log Output for Production

**Category**: Architecture | **Effort**: Low | **Reviewers**: Architect

`src/logger.ts` — Hardcoded to pino-pretty. No JSON output option for log aggregation.

**Fix**: Add `LOG_FORMAT` env var to switch between `pretty` and `json`.

---

## Cost Optimization Summary

| Optimization | Annual Savings (est.) | Effort |
|---|---|---|
| Trim CLAUDE.md (H6) | ~$430/yr at Sonnet | Low |
| Reduce POLL_INTERVAL (H2) | Latency, not cost | Low |
| Task session reuse (L9) | ~$4/yr per daily task | Medium |
| Model routing (Haiku for simple tasks) | 60-80% of routine costs | Medium |

Note: The AI/LLM reviewer suggested defaulting to Haiku for all interactions. This is a product decision — Haiku is significantly less capable than Sonnet for complex reasoning. **Recommendation**: Keep Sonnet as default but evaluate Haiku for scheduled tasks and simple message routing.

---

## Latency Optimization Summary

| Optimization | Latency Reduction | Effort |
|---|---|---|
| Pre-compile TypeScript (H1) | -800-1200ms/spawn | Low |
| Reduce POLL_INTERVAL (H2) | -1000ms avg | Low |
| Mount skills instead of copy (H3) | -50-150ms/spawn | Low |
| Replace IPC polling with fs.watch (H5) | -500-1500ms/IPC round-trip | Medium |
| Progress message delay (L2) | -1250ms perceived | Low |
| Reduce parseBuffer allocations (M2) | -50-200ms on large output | Medium |
| **Combined quick wins** | **~2-3s per interaction** | **Low** |

---

## Implementation Order

**Phase 1 — Security (this week)**:
C1, C2, C3, H7, H8, M6

**Phase 2 — Quick latency wins (this week)**:
H1, H2, H3, H4

**Phase 3 — Reliability hardening (next week)**:
M1, M3, M4, M5, L3, L4

**Phase 4 — Cost + deeper performance (next sprint)**:
H5, H6, M2, M8, L9

**Phase 5 — Backlog (as needed)**:
L1, L2, L5, L6, L7, L8, L10, M7, M9, M10
