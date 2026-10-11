import { describe, expect, it } from "vite-plus/test";
import {
  SAVED_SECRET_MARKER,
  updateDeviceHosts,
  updateEasDeviceHosts,
} from "./deviceHostsSettings.logic";

describe("device host changes across environments", () => {
  const shared = { id: "shared", label: "Mac mini", target: "julius@macmini" };
  const local = { id: "other", label: "Android", target: "julius@android" };

  it("adds to differing host lists without losing environment-specific hosts, including on retry", () => {
    const environments = [[], [local], [shared, local]];
    const saved = environments.map((hosts) => updateDeviceHosts(hosts, shared, false));
    expect(saved).toEqual([[shared], [local, shared], [shared, local]]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, shared, false))).toEqual(saved);
  });

  it("edits and removes the shared host while preserving unrelated hosts", () => {
    const edited = { ...shared, target: "julius@new-address" };
    const saved = [[shared], [local, shared]].map((hosts) =>
      updateDeviceHosts(hosts, edited, false),
    );
    expect(saved).toEqual([[edited], [local, edited]]);
    expect(saved.map((hosts) => updateDeviceHosts(hosts, edited, true))).toEqual([[], [local]]);
  });

  it("recognizes a host added separately on another environment and preserves its local ID", () => {
    const remote = { ...shared, id: "remote-id" };
    const edited = { ...shared, target: "julius@new-address" };
    expect(updateDeviceHosts([remote, local], shared, false)).toEqual([remote, local]);
    const saved = updateDeviceHosts([remote, local], edited, false, shared);
    expect(saved).toEqual([{ ...edited, id: remote.id }, local]);
    expect(updateDeviceHosts(saved, edited, false, shared)).toEqual(saved);
    expect(updateDeviceHosts([remote, local], shared, true)).toEqual([local]);
  });

  it("keeps distinct SSH connections to the same target separate", () => {
    const anotherPort = { ...shared, id: "another-port", port: 2222 };
    const anotherIdentity = { ...shared, id: "another-key", identityFile: "~/.ssh/another" };
    expect(updateDeviceHosts([anotherPort, anotherIdentity], shared, false)).toEqual([
      anotherPort,
      anotherIdentity,
      shared,
    ]);
  });

  it("prefers the selected ID over a sibling with the same destination", () => {
    const sibling = { ...shared, id: "sibling", label: "Another entry" };
    const edited = { ...shared, label: "Renamed" };
    expect(updateDeviceHosts([sibling, shared], edited, false, shared)).toEqual([sibling, edited]);
    expect(updateDeviceHosts([sibling, shared], shared, true)).toEqual([sibling]);
  });

  it("refuses an ambiguous destination on another environment instead of changing a sibling", () => {
    const remote = { ...shared, id: "remote" };
    const sibling = { ...shared, id: "sibling" };
    expect(() => updateDeviceHosts([remote, sibling], shared, true)).toThrow("Multiple hosts");
    expect(() => updateDeviceHosts([remote, sibling], shared, false)).toThrow("Multiple hosts");
  });
});

describe("EAS host changes across environments", () => {
  const ssh = { id: "ssh-host", label: "Mac mini", target: "julius@macmini" };
  const project = { id: "eas", label: "App", projectId: "project-1", accessToken: "token" };
  const ids = (values: string[]) => () => values.shift() ?? "exhausted";

  it("gives a new host a fresh ID when it collides with an SSH host", () => {
    const colliding = { ...project, id: ssh.id };
    expect(updateEasDeviceHosts([], [ssh], colliding, false, ids([ssh.id, "fresh"]))).toEqual([
      { ...project, id: "fresh" },
    ]);
    expect(updateEasDeviceHosts([], [ssh], project, false, ids([]))).toEqual([project]);
  });

  it("edits a project saved under another environment's ID and keeps its saved token", () => {
    const remote = { ...project, id: "remote", accessToken: SAVED_SECRET_MARKER };
    const edited = { ...project, label: "Renamed", accessToken: SAVED_SECRET_MARKER };
    const saved = updateEasDeviceHosts([remote], [], edited, false, ids([]), project);
    expect(saved).toEqual([{ ...edited, id: "remote" }]);
    expect(updateEasDeviceHosts(saved, [], edited, true, ids([]), project)).toEqual([]);
  });

  it("refuses an ambiguous project instead of changing a sibling", () => {
    const first = { ...project, id: "first" };
    const second = { ...project, id: "second" };
    expect(() => updateEasDeviceHosts([first, second], [], project, false, ids([]))).toThrow(
      "Multiple EAS hosts",
    );
  });
});
