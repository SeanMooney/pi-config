# Pi Agent Config Guidance

This repository is the Pi agent configuration directory managed via dotfiles / Nix Home Manager.

- Follow the XDG-oriented Pi layout configured by environment variables.
- Do not assume Pi config lives at `~/.pi/agent`; resolve paths from `PI_CODING_AGENT_DIR` when planning or changing config.
- Do not assume the default session location; respect `PI_CODING_AGENT_SESSION_DIR` for session-related work.
- Prefer repository-relative paths when editing this config repo, and mention the corresponding environment-variable path in plans.
- Keep this file minimal; put detailed workflow guidance in dedicated docs or extension comments.
