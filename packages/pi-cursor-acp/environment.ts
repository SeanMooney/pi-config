const FORWARDED_ENV_NAMES = new Set([
  "ALL_PROXY",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LANGUAGE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TMP",
  "TMPDIR",
  "TEMP",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_DIRS",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function cursorChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (FORWARDED_ENV_NAMES.has(name) || name.startsWith("LC_"))) {
      environment[name] = value;
    }
  }
  return { ...environment, ...overrides };
}
