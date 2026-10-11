/**
 * A device host is a machine with simulators or emulators on it. The service
 * layer only ever talks to this interface, so the local, SSH, and EAS hosts
 * share discovery, the proxy, and the MCP tools.
 *
 * Local and SSH hosts present a loopback origin where expo-device-hub answers
 * and add an agent-device daemon endpoint after agent access is granted. A
 * cloud host (EAS) has no hub of its own: it creates devices on demand, so it
 * implements `managed` and maps hub routes onto each device's own preview
 * server.
 */
import type {
  DeviceActionInput,
  DeviceActionType,
  DeviceHostId,
  DeviceHostSummary,
  DeviceId,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { NodeRuntimeUnavailableError } from "@t3tools/shared/nodeRuntime";

export class DeviceHostError extends Schema.TaggedError<DeviceHostError>()("DeviceHostError", {
  hostId: Schema.String,
  step: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Device host ${this.hostId} failed while ${this.step}.`;
  }
}

export class DeviceHostTimeoutError extends Schema.TaggedError<DeviceHostTimeoutError>()(
  "DeviceHostTimeoutError",
  { hostId: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Device host ${this.hostId} did not start agent tools within ${this.timeoutMs} ms.`;
  }
}

export interface DeviceHubUpstream {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** WebSocket subprotocols, for upstreams that read their credential there. */
  readonly protocols?: ReadonlyArray<string>;
}

export interface DeviceHubEndpoint {
  /** Loopback origin of expo-device-hub, e.g. `http://127.0.0.1:3400`. */
  readonly origin: string;
  /**
   * Resolves a hub path (with its query) for hosts that are not one
   * expo-device-hub. Null means the route does not exist there.
   */
  readonly upstream?: (path: string, search: URLSearchParams) => DeviceHubUpstream | null;
}

/** Where a hub route is served on this host. */
export const hubUpstream = (
  hub: DeviceHubEndpoint,
  path: string,
  search: URLSearchParams = new URLSearchParams(),
): DeviceHubUpstream | null =>
  hub.upstream
    ? hub.upstream(path, search)
    : { url: `${hub.origin}${path}${search.size > 0 ? `?${search.toString()}` : ""}` };

/**
 * Discovery and power for a host whose devices exist only while T3 runs them.
 * Each device brings its own agent-device daemon, so agent access is per
 * platform rather than per host.
 */
export interface ManagedDevices {
  readonly list: Effect.Effect<ReadonlyArray<DeviceSummary>, DeviceHostError>;
  /** Starts the device and returns its id once it can stream. */
  readonly boot: (device: DeviceSummary) => Effect.Effect<DeviceId, DeviceHostError>;
  readonly shutdown: (
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) => Effect.Effect<void, DeviceHostError>;
  /** The daemon of the running device on `platform`, if one is running. */
  readonly agentDevice: (platform: DevicePlatform) => Effect.Effect<AgentDeviceEndpoint | null>;
  /** Tools-drawer actions these devices accept, run without host commands. */
  readonly supportedActions: (platform: DevicePlatform) => ReadonlyArray<DeviceActionType>;
  readonly action: (
    device: DeviceSummary,
    input: DeviceActionInput,
  ) => Effect.Effect<void, DeviceHostError>;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** Host-local path of the agent-device entry script. The provider uses a separate local CLI install. */
  readonly entryPath: string;
}

export interface DeviceHostReady {
  readonly nodePath: string;
  readonly hub: DeviceHubEndpoint;
  /**
   * Runs a host command (`xcrun`, `adb`, or a helper bundled with the hub)
   * where the devices live. On the local host this is a plain spawn; a
   * remote host would run it over its transport.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  /** Absolute paths of helper binaries vendored with the hub, when present. */
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

export interface DeviceHostAgentReady extends DeviceHostReady {
  readonly agentDevice: AgentDeviceEndpoint;
}

export class DeviceHost extends Context.Service<
  DeviceHost,
  {
    readonly id: DeviceHostId;
    readonly summary: Effect.Effect<DeviceHostSummary>;
    readonly inspect?: Effect.Effect<DeviceHostSummary, DeviceHostError>;
    readonly platformAvailability: (
      platform: DevicePlatform,
    ) => Effect.Effect<DevicePlatformAvailability>;
    /**
     * Installs tools on first use and starts the helper processes. Idempotent:
     * concurrent callers share one start, and a ready host returns immediately.
     */
    readonly ensureReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<DeviceHostReady, DeviceHostError | NodeRuntimeUnavailableError>;
    /** Installs and starts agent-device after the user grants agent access. */
    readonly ensureAgentReady: (
      onPhase: (phase: "installing" | "starting", detail?: string) => Effect.Effect<void>,
    ) => Effect.Effect<
      DeviceHostAgentReady,
      DeviceHostError | DeviceHostTimeoutError | NodeRuntimeUnavailableError
    >;
    /** Current endpoints when already running, without starting anything. */
    readonly current: Effect.Effect<DeviceHostReady | null>;
    /** Stops only agent-device. Manual viewing through the hub stays available. */
    readonly stopAgent: Effect.Effect<void>;
    /** Stops helpers. Devices themselves keep running; the user owns those. */
    readonly stop: Effect.Effect<void>;
    readonly managed?: ManagedDevices;
  }
>()("t3/device/DeviceHost") {}
