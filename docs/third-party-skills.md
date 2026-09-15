# Third-party skills

Third-party skill repositories are pinned as Git submodules under `vendor/`. Pi
loads only the skill directories listed in `settings.json`; it does not scan
every skill or extension in those repositories.

The selected skills are:

- `unslop` and `technical-writing` from `vendor/cursor-plugins`
- `ponytail` from `vendor/ponytail`

Initialize the pinned revisions after cloning this configuration repository:

```bash
git submodule update --init --recursive
```

Pi does not initialize submodules. If a submodule is absent, its configured
skills are unavailable.

## Update a pin

Fetch upstream and inspect the proposed revision before changing a pin:

```bash
git -C vendor/cursor-plugins fetch origin main
git -C vendor/cursor-plugins log --oneline HEAD..origin/main
git -C vendor/cursor-plugins checkout --detach <reviewed-commit>
git add vendor/cursor-plugins
```

Use the same process for `vendor/ponytail`. Review the selected `SKILL.md` and
license at the new revision before staging the gitlink.

After an update, restart Pi or run `/reload` and confirm that only the intended
skills are available.
