import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { access, realpath, stat } from "node:fs/promises";

// Canonical checks close namespace and symlink escapes at routing time. As with
// any filesystem policy, a later filesystem change can still race the read.

export type LocalReadEntry =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "tree"; readonly path: string };

export type LocalReadDecision =
  | { readonly kind: "remote" }
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "denied"; readonly path: string; readonly reason: string };

export interface LocalReadRejection {
  readonly entry: LocalReadEntry;
  readonly reason: string;
}

export interface LocalReadRegistrationReport {
  readonly accepted: readonly LocalReadEntry[];
  readonly rejected: readonly LocalReadRejection[];
  readonly installed: boolean;
}

export interface LocalReadRegistry {
  replace(owner: symbol, entries: readonly LocalReadEntry[]): Promise<LocalReadRegistrationReport>;
  remove(owner: symbol): void;
  route(path: string): Promise<LocalReadDecision>;
  clear(): void;
}

interface RegisteredEntry {
  readonly entry: LocalReadEntry;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
}

interface CanonicalRequest {
  readonly path: string;
  readonly lexicalPath: string;
  readonly canonicalAncestor: string;
  readonly existing: boolean;
}

const isContained = (candidate: string, root: string): boolean => {
  const remainder = relative(root, candidate);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
};

const isFilesystemRoot = (path: string): boolean => dirname(path) === path;
const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const narrowNoBreakSpace = "\u202F";

function readPathCandidates(inputPath: string): readonly string[] {
  const normalized = inputPath.replace(unicodeSpaces, " ");
  const nfd = normalized.normalize("NFD");
  const curly = normalized.replace(/'/g, "\u2019");
  const nfdCurly = nfd.replace(/'/g, "\u2019");
  const screenshot = normalized.replace(/ (AM|PM)\./gi, `${narrowNoBreakSpace}$1.`);
  return [...new Set([normalized, screenshot, nfd, curly, nfdCurly])];
}

async function canonicalizeRequest(lexicalPath: string): Promise<CanonicalRequest> {
  try {
    const canonicalPath = await realpath(lexicalPath);
    return {
      path: canonicalPath,
      lexicalPath,
      canonicalAncestor: canonicalPath,
      existing: true,
    };
  } catch {
    let current = lexicalPath;
    while (true) {
      try {
        const canonicalAncestor = await realpath(current);
        return {
          path: resolve(canonicalAncestor, relative(current, lexicalPath)),
          lexicalPath,
          canonicalAncestor,
          existing: false,
        };
      } catch {
        const parent = dirname(current);
        if (parent === current) {
          throw new Error(`No existing ancestor for ${lexicalPath}`);
        }
        current = parent;
      }
    }
  }
}

async function resolveReadRequest(candidates: readonly string[]): Promise<CanonicalRequest> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      const canonicalPath = await realpath(candidate);
      return {
        path: canonicalPath,
        lexicalPath: candidate,
        canonicalAncestor: canonicalPath,
        existing: true,
      };
    } catch {
      // Pi's read path resolver tries the next spelling when this one is absent.
    }
  }
  return canonicalizeRequest(candidates[0]!);
}

async function validateEntry(entry: LocalReadEntry): Promise<RegisteredEntry> {
  const lexicalPath = resolve(entry.path);
  if (!isAbsolute(entry.path)) {
    throw new Error("path must be absolute");
  }
  if (entry.kind === "tree" && isFilesystemRoot(lexicalPath)) {
    throw new Error("filesystem root cannot be registered as a tree");
  }

  await access(lexicalPath);
  const fileStat = await stat(lexicalPath);
  if (entry.kind === "file" && !fileStat.isFile()) {
    throw new Error("file entry must identify a regular file");
  }
  if (entry.kind === "tree" && !fileStat.isDirectory()) {
    throw new Error("tree entry must identify a directory");
  }

  const canonicalPath = await realpath(lexicalPath);
  if (entry.kind === "tree" && isFilesystemRoot(canonicalPath)) {
    throw new Error("filesystem root cannot be registered as a tree");
  }
  return { entry, lexicalPath, canonicalPath };
}

function lexicalMatch(entry: RegisteredEntry, lexicalPath: string): boolean {
  const roots = [entry.lexicalPath, entry.canonicalPath];
  return roots.some((root) =>
    entry.entry.kind === "file" ? lexicalPath === root : isContained(lexicalPath, root),
  );
}

function canonicalMatch(entry: RegisteredEntry, request: CanonicalRequest): boolean {
  return entry.entry.kind === "file"
    ? request.existing && request.path === entry.canonicalPath
    : isContained(request.path, entry.canonicalPath) &&
        isContained(request.canonicalAncestor, entry.canonicalPath);
}

export function createLocalReadRegistry(): LocalReadRegistry {
  const owners = new Map<symbol, RegisteredEntry[]>();
  const generations = new Map<symbol, number>();
  let lifecycleGeneration = 0;
  let authorizationVersion = 0;

  const replace = async (
    owner: symbol,
    entries: readonly LocalReadEntry[],
  ): Promise<LocalReadRegistrationReport> => {
    const ownerGeneration = (generations.get(owner) ?? 0) + 1;
    generations.set(owner, ownerGeneration);
    const replaceLifecycleGeneration = lifecycleGeneration;
    // Keep the previous snapshot visible until validation completes. Routes
    // already holding it are fenced by authorizationVersion; the validated
    // subset replaces it atomically below, avoiding a remote-routing window.
    authorizationVersion += 1;
    const accepted: LocalReadEntry[] = [];
    const rejected: LocalReadRejection[] = [];
    const validated: RegisteredEntry[] = [];

    for (const entry of entries) {
      try {
        const registration = await validateEntry(entry);
        accepted.push(entry);
        validated.push(registration);
      } catch (error) {
        rejected.push({
          entry,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const installed =
      lifecycleGeneration === replaceLifecycleGeneration &&
      generations.get(owner) === ownerGeneration;
    if (installed) {
      owners.set(owner, validated);
      authorizationVersion += 1;
    }
    return { accepted, rejected, installed };
  };

  return {
    replace,
    remove(owner) {
      generations.set(owner, (generations.get(owner) ?? 0) + 1);
      owners.delete(owner);
      authorizationVersion += 1;
    },
    async route(inputPath) {
      if (!isAbsolute(inputPath)) return { kind: "remote" };

      const rawPath = resolve(inputPath);
      const entries = [...owners.values()].flat();
      // Namespace classification starts from the exact spelling supplied by
      // the caller. Pi normalization may only refine an already-approved
      // spelling; it must not turn an unregistered alias into a local read.
      const rawMatches = entries.filter((entry) => lexicalMatch(entry, rawPath));
      if (rawMatches.length === 0) return { kind: "remote" };

      const candidates = readPathCandidates(rawPath).map((path) => resolve(path));
      const lexicalMatches = rawMatches.filter((entry) =>
        candidates.some((candidate) => lexicalMatch(entry, candidate)),
      );

      const routeVersion = authorizationVersion;
      let request: CanonicalRequest;
      try {
        request = await resolveReadRequest(candidates);
      } catch (error) {
        return {
          kind: "denied",
          path: candidates[0]!,
          reason: error instanceof Error ? error.message : String(error),
        };
      }

      if (routeVersion !== authorizationVersion) {
        return {
          kind: "denied",
          path: request.path,
          reason: "local read authorization changed while resolving the path",
        };
      }

      const localMatch = lexicalMatches.find(
        (entry) => lexicalMatch(entry, request.lexicalPath) && canonicalMatch(entry, request),
      );
      if (localMatch) {
        const delegatedRequest = await resolveReadRequest(readPathCandidates(request.path));
        if (routeVersion !== authorizationVersion) {
          return {
            kind: "denied",
            path: request.path,
            reason: "local read authorization changed while validating the final path",
          };
        }
        if (
          delegatedRequest.existing &&
          (!request.existing || delegatedRequest.path !== request.path)
        ) {
          return {
            kind: "denied",
            path: delegatedRequest.path,
            reason: "Pi read path normalization resolves to a different resource",
          };
        }
        if (localMatch.entry.kind === "file" && !request.existing) {
          return {
            kind: "denied",
            path: request.path,
            reason: "registered file no longer exists",
          };
        }
        return { kind: "local", path: request.path };
      }
      return {
        kind: "denied",
        path: request.path,
        reason: "path escapes the registered canonical resource",
      };
    },
    clear() {
      lifecycleGeneration += 1;
      owners.clear();
      generations.clear();
      authorizationVersion += 1;
    },
  };
}

export { isContained };
