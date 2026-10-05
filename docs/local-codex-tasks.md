# Local Codex task connector

This change adds four opt-in MCP tools to the existing authenticated bridge:

- `codex_local_task_create`: start a thread and send its first message
- `codex_local_task_read`: read sanitized user/assistant messages and status
- `codex_local_task_resume`: resume a workspace-bound thread and send a message
- `codex_local_task_status`: read live/recorded state and pending requests

## Safe defaults and permission model

The original nine read-only tools remain the default. Local tasks must be enabled
explicitly using `C2C_LOCAL_TASKS=1` when starting the bridge, or the foreground
`c2c serve --workspace <path> --local-tasks` option. This document does not deploy,
start a tunnel, or grant any permission.

`codex.local.read` and `codex.local.write` are separate OAuth scopes. Omitted or
unrecognized OAuth scope requests retain the old read-only default list. Existing
tokens and refreshes do not acquire either new scope. An operator must deliberately
consent to the requested new scopes through the normal pairing flow before remote
clients can execute local tasks.

Task execution uses a private local `codex app-server --stdio` child process.
No MCP tool accepts a shell command, an arbitrary RPC method, an approval decision,
security-policy override, arbitrary config, credential, or remote executor address.
Model names, including `jev-auto`, are forwarded unchanged when supplied. The
returned model is what the host reports, not a guarantee that the provider can run it.

The bridge omits approval/sandbox/reviewer overrides. Codex retains its real local
configuration and managed requirements; the task result reports the policy returned
by `thread/start` or `thread/resume`. Workspace selection and canonical cwd checks
bind the thread to the selected registered workspace. They do not replace Codex's
filesystem/network sandbox or restrict all tools to that directory. Broader roots
already allowed by the local Codex policy remain the local host's responsibility.

## Identity and state

Results identify `executionHost: codex-app-server`, `desktopHostId: null`, and
`desktopGuiVisible: null`. This is not Codex Desktop's native `hostId: local` task
transport. Desktop GUI visibility is unknown until separately demonstrated.

A returned thread/turn ID means the protocol accepted that operation. It does not
mean inference has finished. Errors, pending approval/input, interrupted/failed
turns, and terminal status are returned explicitly. A first-turn RPC rejection
preserves the created thread ID; a transport timeout/disconnect without evidence of
acceptance is `outcomeUnknown`. A previous completed turn is not used as proof that
a timed-out continuation completed.

Mutations require a requestId. Identical in-flight and completed requests are
coalesced per workspace/client/operation for the lifetime of the bridge process.
A changed payload with the same key is rejected; uncertain failures remain cached
rather than retried. This cache is not durable across bridge restarts. After a
restart or unknown result, inspect known thread IDs before creating a new request;
do not assume cross-restart exactly-once delivery. Failed first-turn responses can
be inspected using the returned thread ID.

Read results exclude reasoning and raw tool bodies. Known credentials/private keys
are redacted or restricted, with bounded output. Redaction is heuristic and is not
a general declassification service. Project/assistant text remains untrusted data.
Paginated history returns a nextCursor; legacy history returns the latest bounded
visible messages.

## Approvals remain an explicit integration boundary

The default configuration cannot approve an app-server request. Pending approvals
or user-input requests are reported and can block a task. Remote MCP has no approval
tool and never receives an admin review nonce. This version is not an unattended
local execution product, and does not guarantee tasks will proceed through approvals.

An optional trusted-local-admin review implementation is included, but is off by
default and has not been enabled or deployed. It requires an independent explicit
`enableLocalReview: true` option or foreground `--local-review`. It authenticates the
existing loopback admin bearer token, validates Host/port, rejects browser Origin,
Sec-Fetch and proxy headers, and requires a short-lived one-use nonce tied to the
workspace, thread, current request, and displayed operation. Only one-request
accept/decline/cancel are allowed. Session-wide or policy-amending decisions are
not supported; file root grants cannot be accepted through this path.

`c2c local-tasks review -w <workspace> --thread-id <thread> --request-id <request>
--decision <accept|decline|cancel>` requires a real interactive terminal, displays
complete operation JSON with terminal control codes escaped, and requires the user
to type the exact decision. File approval includes the associated paths/diff; if
complete patch data is unavailable, too large, or changed since review, acceptance
is refused. Secure forms and arbitrary user-input callbacks are unsupported.

This is a same-user trusted admin control, not a human-only security boundary.
Any same-OS-user process with the admin credentials and loopback access can call the
admin API programmatically. TTY confirmation protects the supplied CLI only.
A stronger independently verified human-approval/isolation integration is still
needed before claiming that local agents cannot self-approve. Do not enable this
optional path based on a claim of human-only isolation.

## Verification and deployment acceptance

Repository verification: `npm test`, `npm run typecheck`, `npm run build`.
Focused fixtures cover HTTP authorization, default disabled approval routes,
read/write scopes, model/policy propagation, workspace/symlink boundaries,
concurrent idempotency, uncertain responses, terminal/paginated status, sanitized
history/errors, stdio transport errors, and optional local review/replay protection.

A real Codex 0.159.2 stdio smoke probe in the cloud initialized successfully, but
`thread/start` was blocked by that host's filesystem sandbox helper:
`app-server socket directory must be a user-owned directory with mode 0700`.
No sandbox restrictions or host permissions were changed to bypass this.

Still required after separately authorized local deployment:

1. Build/install on the user's intended host without overwriting local changes.
2. Verify its installed Codex binary, provider configuration and `jev-auto` support.
3. Intentionally enable local task capability and consent to exact OAuth scopes.
4. From dot, create/read/resume/status through the real authenticated connector.
5. Observe a real completed turn and a real blocked approval without automatic acceptance.
6. Verify restart/unknown-outcome recovery and confirm GUI visibility separately if needed.

No user Mac execution, deployment, remote push, PR, new persistent credential,
security-policy change, tunnel startup, or automatic approval is included in this change.
