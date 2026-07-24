import { Data } from "effect";

export class DelegationBusyError extends Data.TaggedError("DelegationBusyError")<{
  readonly message: string;
}> {}

export class ProfileResolutionError extends Data.TaggedError("ProfileResolutionError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class CursorCliError extends Data.TaggedError("CursorCliError")<{
  readonly operation: "version" | "models";
  readonly cause: unknown;
  readonly message: string;
}> {}

export class UnsupportedCursorVersionError extends Data.TaggedError(
  "UnsupportedCursorVersionError",
)<{
  readonly actualVersion: string;
  readonly minimumVersion: string;
  readonly message: string;
}> {}

export class CursorModelUnavailableError extends Data.TaggedError("CursorModelUnavailableError")<{
  readonly modelId: string;
  readonly message: string;
}> {}

export class InteractionError extends Data.TaggedError("InteractionError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AcpProcessError extends Data.TaggedError("AcpProcessError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AcpProtocolError extends Data.TaggedError("AcpProtocolError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class AcpModelMismatchError extends Data.TaggedError("AcpModelMismatchError")<{
  readonly actualModelId: string;
  readonly requestedModelId: string;
  readonly message: string;
}> {}

export class CursorReportedFailureError extends Data.TaggedError("CursorReportedFailureError")<{
  readonly output: string;
  readonly message: string;
}> {}

export class OutputCaptureError extends Data.TaggedError("OutputCaptureError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export type AcpError =
  | AcpProcessError
  | AcpProtocolError
  | AcpModelMismatchError
  | CursorReportedFailureError
  | OutputCaptureError;

export class DelegationTimeoutError extends Data.TaggedError("DelegationTimeoutError")<{
  readonly timeoutMs: number;
  readonly message: string;
}> {}

export type DelegationError =
  | DelegationBusyError
  | ProfileResolutionError
  | CursorCliError
  | UnsupportedCursorVersionError
  | CursorModelUnavailableError
  | InteractionError
  | AcpError
  | DelegationTimeoutError;
