# SSH mode

Use `--ssh` to keep Pi on the local control host while routing supported
workspace operations to a remote host:

```console
pi --ssh user@example.com
pi --ssh user@example.com:/path/to/project
pi --ssh user@example.com --ssh-cwd /path/to/project
```

## Remote Bash environment

By default, Bash tool calls and `!` commands run as separate non-interactive
login Bash processes on the remote host. The extension forces SSH not to
allocate a terminal and invokes `bash -lc` before changing to the requested
remote working directory.

A login Bash reads the remote login profile, such as `.bash_profile` or
`.profile`. It reads `.bashrc` only when that profile is configured to source
it. Put environment needed by non-interactive automation in the login profile or
another file that the login profile sources.

Use `--tty` when a command requires a remote terminal or environment configured
only for interactive Bash:

```console
pi --ssh user@example.com:/path/to/project --tty
```

This forces a remote pseudo-terminal for each command and invokes `bash -lic`.
It is not a persistent shell: state such as `cd`, shell variables, and functions
does not carry between tool calls. Pi does not forward keyboard input to the
remote command, so prompts can block until the command is cancelled or times
out. Interactive startup files may also emit extra output, terminal control
sequences, or CRLF line endings.

The `--tty` flag is inert without `--ssh`. File reads, writes, edits, image
detection, and remote working-directory discovery always disable TTY allocation
to avoid terminal translation corrupting their data.

Cancelling or timing out a command terminates the local SSH process tree. SSH
may close the remote session as a result, but the extension cannot guarantee
that detached remote descendants are terminated.
