/**
 * Publish configuration: everything environment-shaped about delivering
 * a change, resolved once and passed in rather than read ambiently.
 *
 * A workflow that commits and publishes runs on a laptop today, in CI
 * tomorrow, and hosted later; the credentials and identity differ in
 * each, so they arrive as data. `publishConfigFromEnv` is the one place
 * that knows the environment variable names.
 *
 * @module git/config
 */

/** The name and email a delivery commit is authored under. */
export interface CommitIdentity {
  name: string;
  email: string;
}

/** How a delivery publishes, resolved from the environment by the caller. */
export interface PublishConfig {
  /**
   * Token for the pull-request step; handed to `gh` as `GH_TOKEN` so no
   * interactive login is needed. Absent, `gh` uses its own stored auth.
   */
  token?: string;
  /** Commit author. Absent, commits carry the default workflow identity. */
  identity?: CommitIdentity;
}

/** The identity used when a `PublishConfig` names none. */
export const DEFAULT_IDENTITY: CommitIdentity = {
  name: 'cycgraph-workflow',
  email: 'workflow@cycgraph.local',
};

/**
 * Resolve a `PublishConfig` from environment variables: `GH_TOKEN` (or
 * `GITHUB_TOKEN`) for the token, `GIT_AUTHOR_NAME` + `GIT_AUTHOR_EMAIL`
 * for the identity — both must be set for the identity to apply.
 */
export function publishConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): PublishConfig {
  const token = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'];
  const name = env['GIT_AUTHOR_NAME'];
  const email = env['GIT_AUTHOR_EMAIL'];
  return {
    ...(token !== undefined ? { token } : {}),
    ...(name !== undefined && email !== undefined ? { identity: { name, email } } : {}),
  };
}
