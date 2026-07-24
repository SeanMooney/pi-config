const SKILL_COMMAND = /^\s*\/skill:cursor-agent(?:\s|$)/i;

const CURSOR_MENTION = /\bcursor(?:\s+agent)?\b/i;
const DELEGATION_ACTION =
  /\b(?:analy[sz]e|ask|audit|check|delegate|explain|find|fix|gather|get|implement|inspect|invoke|investigate|let|modify|review|run|send|summari[sz]e|tell|use)\b/i;

export function isExplicitCursorRequest(text: string): boolean {
  if (SKILL_COMMAND.test(text)) return true;
  return CURSOR_MENTION.test(text) && DELEGATION_ACTION.test(text);
}

export class OneShotAuthorization {
  #authorized = false;

  authorize(): void {
    this.#authorized = true;
  }

  consume(): boolean {
    if (!this.#authorized) return false;
    this.#authorized = false;
    return true;
  }

  clear(): void {
    this.#authorized = false;
  }

  get active(): boolean {
    return this.#authorized;
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
