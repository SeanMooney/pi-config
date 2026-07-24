export class DelegationGate {
  #running = false;

  tryStart(): boolean {
    if (this.#running) return false;
    this.#running = true;
    return true;
  }

  finish(): void {
    this.#running = false;
  }
}

export function argvUsesPiSsh(argv: readonly string[]): boolean {
  return argv.some(
    (arg, index) => arg === "--ssh" || arg.startsWith("--ssh=") || argv[index - 1] === "--ssh",
  );
}

export function isExcludedRuntime(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return (
    env.PI_SUBAGENT_CHILD === "1" ||
    env.PI_SSH_MODE_ACTIVE === "1" ||
    Boolean(env.PI_SSH_REMOTE) ||
    argvUsesPiSsh(argv)
  );
}
