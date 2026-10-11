import type { EasDeviceHostConfig, SshDeviceHostConfig } from "@t3tools/contracts";

/** Apply one host change without replacing another environment's host list. */
export function updateDeviceHosts(
  hosts: ReadonlyArray<SshDeviceHostConfig>,
  host: SshDeviceHostConfig,
  remove: boolean,
  original = host,
): ReadonlyArray<SshDeviceHostConfig> {
  const sameDestination = (candidate: SshDeviceHostConfig, other: SshDeviceHostConfig) =>
    candidate.target === other.target &&
    candidate.port === other.port &&
    candidate.identityFile === other.identityFile;
  const findDestination = (destination: SshDeviceHostConfig) => {
    const matches = hosts.filter((candidate) => sameDestination(candidate, destination));
    if (matches.length > 1) {
      throw new Error(
        "Multiple hosts match this SSH destination. Select the environment to edit its hosts.",
      );
    }
    return matches[0];
  };
  // A retry can encounter the updated destination on an environment that
  // already saved, including one with a different environment-local host ID.
  const existing =
    hosts.find((candidate) => candidate.id === original.id) ??
    findDestination(original) ??
    (remove ? undefined : findDestination(host));
  if (remove) return hosts.filter((candidate) => candidate.id !== existing?.id);
  return existing
    ? hosts.map((candidate) =>
        candidate.id === existing.id ? { ...host, id: existing.id } : candidate,
      )
    : [...hosts, host];
}

/** What a saved EAS access token looks like to clients. Sending it back keeps the token. */
export { SECRET_REDACTED as SAVED_SECRET_MARKER } from "@t3tools/contracts";

/**
 * Apply one EAS host change to an environment's list. Another environment may hold the
 * same project under its own ID, so a host is matched by ID, then by project. Device state
 * keys SSH and EAS hosts by one ID space, so a new host never reuses an SSH host's ID.
 */
export function updateEasDeviceHosts(
  hosts: ReadonlyArray<EasDeviceHostConfig>,
  sshHosts: ReadonlyArray<SshDeviceHostConfig>,
  host: EasDeviceHostConfig,
  remove: boolean,
  newId: () => string,
  original = host,
): ReadonlyArray<EasDeviceHostConfig> {
  const findProject = (projectId: string) => {
    const matches = hosts.filter((candidate) => candidate.projectId === projectId);
    if (matches.length > 1) {
      throw new Error(
        "Multiple EAS hosts use this project. Select the environment to edit its hosts.",
      );
    }
    return matches[0];
  };
  const existing =
    hosts.find((candidate) => candidate.id === original.id) ??
    findProject(original.projectId) ??
    (remove ? undefined : findProject(host.projectId));
  if (remove) return hosts.filter((candidate) => candidate.id !== existing?.id);
  if (existing) {
    // The token marker resolves against this environment's own ID, so it carries over as-is.
    return hosts.map((candidate) =>
      candidate.id === existing.id ? { ...host, id: existing.id } : candidate,
    );
  }
  const taken = new Set([...hosts, ...sshHosts].map((candidate) => candidate.id));
  let id = host.id;
  while (taken.has(id)) id = newId();
  return [...hosts, { ...host, id }];
}
