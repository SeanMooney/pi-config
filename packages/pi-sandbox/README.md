# Pi Sandbox

`pi-sandbox` restricts filesystem access for `read`, `write`, and `edit`, and
network and filesystem access for Bash commands. Blocked operations can prompt
for temporary or persistent permission. The footer shows a lock indicator when
the sandbox is active. Sandboxing is unavailable in SSH mode.

## Setup and configuration

Ensure `rg` (ripgrep) is on the `PATH` used to launch Pi. On Linux, `bwrap`
(bubblewrap) must also be available.

Configure `$PI_CODING_AGENT_DIR/sandbox.json` globally or `.pi/sandbox.json` for
a project. Project settings override global settings, which override the
built-in defaults. Lists replace inherited lists rather than extending them.
Restart Pi after changing configuration.

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["example.com", "*.example.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "allowRead": ["."],
    "denyRead": ["~/.ssh"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

## Commands

- `/sandbox` shows configuration and session allowances.
- `/sandbox-enable` enables sandboxing for the session.
- `/sandbox-disable` disables sandboxing for the session.
- `pi --no-sandbox` starts a session without sandboxing.

## Permissions

Blocked operations offer permission for the session, the project
(`.pi/sandbox.json`), or all projects (`$PI_CODING_AGENT_DIR/sandbox.json`).
Session allowances expire on reload or restart.

- Reads outside `allowRead` prompt for permission. Explicit read allowances
  override `denyRead`; it is not a hard block.
- Writes outside `allowWrite` prompt for permission. `denyWrite` takes
  precedence over allowances and cannot be overridden by a prompt.
- Domains outside `allowedDomains` require permission. `deniedDomains` blocks
  access without a prompt.

`allowedDomains` accepts `*.example.com` for subdomains. Using `"*"` allows all
domains and removes per-domain prompts. Filesystem allowances cover their
directory trees; `"."` covers the current working directory.

Browser support can require `allowBrowserProcess`, `network.allowLocalBinding`,
and `network.allowAllUnixSockets`. These weaken isolation; enable them only when
needed. See the [example config](sandbox.json) for browser-related settings.

## Attribution

Based on Mario Zechner's MIT-licensed
[Pi sandbox example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts).
