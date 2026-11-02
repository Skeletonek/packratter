export interface EnvRef {
  id: string;
  repoId: string;
  name: string;
  /** flatpak only: 'env' (branch named after the environment, default) or 'bundle'. */
  branchMode?: string;
}

export interface PackageMeta {
  filename: string;
  version: string | null;
  arch: string | null;
  ref: string | null;
  size: number;
  sha256: string;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export interface Format {
  validate(tmpPath: string): ValidationResult;
  ingest(env: EnvRef, tmpPath: string, bytes: Buffer): PackageMeta;
  removePackage(
    env: EnvRef,
    pkg: { filename: string; arch: string | null; ref: string | null },
  ): void;
  promote(
    src: EnvRef,
    dst: EnvRef,
    pkg: { filename: string; arch: string | null; ref: string | null },
  ): void;
  rebuild(env: EnvRef, log: (line: string) => void): Promise<void>;
  serveHeaders(path: string): Record<string, string>;
  setupSnippet(repoName: string, baseUrl: string, envName: string, fingerprint: string): string;
  /**
   * Only formats that store data under a name-dependent path implement this.
   * May return package-ref renames the caller must apply to packages.ref.
   */
  renameEnv?(env: EnvRef, newName: string): RefRename[] | void;
}

/** A stored package ref that a renameEnv moved to a new value. */
export interface RefRename {
  oldRef: string;
  newRef: string;
}
