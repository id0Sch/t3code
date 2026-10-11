/**
 * EAS Simulator as a device host: Expo's cloud iOS simulators and Android
 * emulators. A cloud device exists only while a session runs, so this host
 * lists one placeholder per platform, starts a billed session when one is
 * opened, and stops it when it is shut down or the host goes away. Every
 * session also carries Expo-side idle and duration caps, so a server that dies
 * without stopping it does not leave it running.
 *
 * A session serves the same tools T3 runs locally, behind a token: an
 * agent-device daemon, and a preview server that is expo-device-hub for
 * Android and a bare serve-sim for iOS. `upstream` maps hub routes onto those
 * servers so the proxy, screenshots, and the panel stream work unchanged,
 * except that iOS video is only offered over WebRTC.
 */
import type {
  DeviceActionInput,
  DeviceActionType,
  DeviceHostSummary,
  DevicePlatform,
  DevicePlatformAvailability,
  DeviceSummary,
  EasDeviceHostConfig,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { IOS_TEXT_SIZES } from "./DeviceActions.ts";
import { ensureAgentDevice } from "./DeviceToolchain.ts";

const EXPO_GRAPHQL_URL = "https://api.expo.dev/graphql";
/** Expo stops a session on its own after these, even if T3 never does. */
export const EAS_SESSION_MAX_MINUTES = 60;
export const EAS_SESSION_MAX_IDLE_MINUTES = 15;
const POLL_INTERVAL = Duration.seconds(5);
/** Queue time counts too; Expo's own CLI allows 15 minutes after the queue. */
const START_TIMEOUT = Duration.minutes(20);
const PREVIEW_READY_TIMEOUT = Duration.minutes(2);

const PLATFORMS: ReadonlyArray<DevicePlatform> = ["ios", "android"];

const GraphqlResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  });

const CreatedSession = Schema.Struct({
  deviceRunSession: Schema.Struct({
    createDeviceRunSession: Schema.Struct({
      id: Schema.String,
      app: Schema.Struct({
        slug: Schema.String,
        ownerAccount: Schema.Struct({ name: Schema.String }),
      }),
    }),
  }),
});

const SessionState = Schema.Struct({
  deviceRunSessions: Schema.Struct({
    byId: Schema.Struct({
      status: Schema.String,
      turtleJobRun: Schema.optional(Schema.NullOr(Schema.Struct({ status: Schema.String }))),
      remoteConfig: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            agentDeviceRemoteSessionUrl: Schema.optional(Schema.NullOr(Schema.String)),
            agentDeviceRemoteSessionToken: Schema.optional(Schema.NullOr(Schema.String)),
            webPreviewToken: Schema.optional(Schema.NullOr(Schema.String)),
            previewApiUrl: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    }),
  }),
});

const StoppedSession = Schema.Struct({
  deviceRunSession: Schema.Struct({
    ensureDeviceRunSessionStopped: Schema.Struct({ id: Schema.String }),
  }),
});

const ExpoState = Schema.Struct({
  auth: Schema.optional(
    Schema.NullOr(Schema.Struct({ sessionSecret: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
const decodeExpoState = Schema.decodeUnknownEffect(Schema.fromJsonString(ExpoState));

const decodeAgentDeviceResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      success: Schema.Boolean,
      error: Schema.optional(Schema.Struct({ message: Schema.String })),
    }),
  ),
);

const IosPreview = Schema.Struct({ device: Schema.String });
const AndroidPreview = Schema.Struct({
  emulators: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, version: Schema.String }),
  ),
});

const CREATE_SESSION = `mutation T3CreateDeviceRunSession($input: CreateDeviceRunSessionInput!) {
  deviceRunSession { createDeviceRunSession(deviceRunSessionInput: $input) {
    id
    app { slug ownerAccount { name } }
  } }
}`;
const SESSION_STATE = `query T3DeviceRunSession($id: ID!) {
  deviceRunSessions { byId(deviceRunSessionId: $id) {
    status
    turtleJobRun { status }
    remoteConfig { ... on AgentDeviceRunSessionRemoteConfig {
      agentDeviceRemoteSessionUrl agentDeviceRemoteSessionToken webPreviewToken previewApiUrl
    } }
  } }
}`;
const LATEST_BUILDS = `query T3LatestSimulatorBuild($appId: String!, $filter: BuildFilter) {
  app { byId(appId: $appId) { builds(offset: 0, limit: 10, filter: $filter) {
    id artifacts { applicationArchiveUrl }
  } } }
}`;
const LatestBuilds = Schema.Struct({
  app: Schema.Struct({
    byId: Schema.Struct({
      builds: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          artifacts: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                applicationArchiveUrl: Schema.optional(Schema.NullOr(Schema.String)),
              }),
            ),
          ),
        }),
      ),
    }),
  }),
});
const STOP_SESSION = `mutation T3StopDeviceRunSession($id: ID!) {
  deviceRunSession { ensureDeviceRunSessionStopped(deviceRunSessionId: $id) { id } }
}`;

/** What Expo said went wrong, worded for the user. */
export class ExpoApiError extends Schema.TaggedError<ExpoApiError>()("ExpoApiError", {
  message: Schema.String,
}) {}

const ENDED_SESSION_STATUSES = new Set(["ERRORED", "STOPPED"]);
const ENDED_JOB_STATUSES = new Set(["ERRORED", "CANCELED", "FINISHED"]);

interface Session {
  readonly id: string;
  readonly device: DeviceSummary;
  readonly previewOrigin: string;
  readonly previewToken: string | null;
  readonly agent: DeviceHost.AgentDeviceEndpoint;
}

const placeholder = (hostId: string, platform: DevicePlatform): DeviceSummary => ({
  hostId,
  id: platform,
  platform,
  name: platform === "ios" ? "iOS Simulator" : "Android Emulator",
  version: "EAS",
  booted: false,
  physical: false,
  // EAS serves iOS video only over WebRTC; Android's cloud hub streams the usual way.
  ...(platform === "ios" ? { transport: "webrtc" as const } : {}),
});

const vendorPlatform = (path: string): DevicePlatform | null =>
  path.startsWith("/vendor/serve-sim/")
    ? "ios"
    : path.startsWith("/vendor/serve-emu/")
      ? "android"
      : null;

/**
 * Hub routes on a session's preview server. Android's is expo-device-hub, so
 * paths carry over. iOS's is a bare serve-sim at the root, whose input socket
 * names the device in the path rather than the query.
 */
export const easUpstream = (
  session: Pick<Session, "previewOrigin" | "previewToken"> & { readonly platform: DevicePlatform },
  path: string,
  search: URLSearchParams,
): DeviceHost.DeviceHubUpstream | null => {
  if (vendorPlatform(path) !== session.platform) return null;
  const query = new URLSearchParams(search);
  let upstreamPath = path;
  if (session.platform === "ios") {
    upstreamPath = path.slice("/vendor/serve-sim".length);
    if (upstreamPath === "/helper/ws") {
      const device = query.get("device");
      if (!device) return null;
      query.delete("device");
      upstreamPath = `/helper/${encodeURIComponent(device)}/ws`;
    }
  }
  const token = session.previewToken;
  return {
    url: `${session.previewOrigin}${upstreamPath}${query.size > 0 ? `?${query.toString()}` : ""}`,
    ...(token
      ? {
          headers: { authorization: `Bearer ${token}` },
          protocols: [`serve-sim.token.${token}`],
        }
      : {}),
  };
};

/** Drawer actions a cloud device takes through its agent-device daemon; it has no host shell. */
const SUPPORTED_ACTIONS: ReadonlyArray<DeviceActionType> = [
  "setAppearance",
  "setTextSize",
  "setLocation",
  "setPermission",
  "openUrl",
  "launchApp",
  "terminateApp",
  "sendPush",
];

/** agent-device arguments for a drawer action, or null when it has no equivalent. */
export const agentDeviceActionArgs = (input: DeviceActionInput): ReadonlyArray<string> | null => {
  switch (input.type) {
    case "setAppearance":
      return ["settings", "appearance", input.value];
    case "setTextSize":
      // agent-device names iOS categories on both platforms and maps Android to the nearest scale.
      return ["settings", "text-size", IOS_TEXT_SIZES[input.value]];
    case "setLocation":
      return ["settings", "location", "set", String(input.latitude), String(input.longitude)];
    case "setPermission":
      if (input.permission === "faceid") return null;
      return [
        "settings",
        "permission",
        input.decision === "revoke" ? "deny" : input.decision,
        input.permission,
        "--app",
        input.appId,
      ];
    case "openUrl":
      return ["open", input.url];
    case "launchApp":
      return ["open", input.appId];
    case "terminateApp":
      return ["close", input.appId];
    case "sendPush":
      return [
        "push",
        input.appId,
        JSON.stringify(
          typeof input.payload === "string" ? { aps: { alert: input.payload } } : input.payload,
        ),
      ];
    default:
      return null;
  }
};

/** `label` is read on each summary, so renaming a project does not restart its sessions. */
export const make = Effect.fn("EasDeviceHost.make")(function* (
  config: EasDeviceHostConfig,
  label: () => string = () => config.label,
) {
  const http = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const server = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcess.Platform;
  const sessions = new Map<DevicePlatform, Session>();
  /** Bumped by `stopAll`; a start that finishes after a bump stops instead of keeping its session. */
  let generation = 0;
  const platformLocks = new Map<DevicePlatform, Semaphore.Semaphore>();
  for (const platform of PLATFORMS) platformLocks.set(platform, yield* Semaphore.make(1));

  const hostError = (step: string) => (cause: unknown) =>
    new DeviceHost.DeviceHostError({ hostId: config.id, step, cause });

  /** The configured token, then `EXPO_TOKEN`, then the session `eas login` left behind. */
  const credentials = Effect.gen(function* () {
    if (config.accessToken.length > 0) return { authorization: `Bearer ${config.accessToken}` };
    const token = environment.EXPO_TOKEN?.trim();
    if (token) return { authorization: `Bearer ${token}` };
    const state = yield* fs
      .readFileString(path.join(home, ".expo", "state.json"))
      .pipe(Effect.flatMap(decodeExpoState), Effect.option);
    const secret = Option.getOrUndefined(state)?.auth?.sessionSecret;
    return secret ? { "expo-session": secret } : null;
  });

  const platforms = credentials.pipe(
    Effect.map(
      (auth): ReadonlyArray<DevicePlatformAvailability> =>
        PLATFORMS.map((platform) =>
          auth
            ? { platform, available: true }
            : {
                platform,
                available: false,
                reason:
                  "Not signed in to Expo. Add an access token to this host in Settings, or run `eas login` on the server machine.",
              },
        ),
    ),
  );

  const graphql = <A extends Schema.Top>(
    query: string,
    variables: Record<string, unknown>,
    schema: A,
    step: string,
  ) =>
    Effect.gen(function* () {
      const auth = yield* credentials;
      if (!auth) return yield* new ExpoApiError({ message: "Not signed in to Expo." });
      const response = yield* http.execute(
        HttpClientRequest.post(EXPO_GRAPHQL_URL).pipe(
          HttpClientRequest.setHeaders(auth),
          HttpClientRequest.bodyJsonUnsafe({ query, variables }),
        ),
      );
      const body = yield* HttpClientResponse.schemaBodyJson(GraphqlResponse(schema))(response);
      if (body.errors?.length || !body.data) {
        return yield* new ExpoApiError({
          message:
            body.errors?.map((error) => error.message).join("\n") ??
            `Expo API responded ${response.status}.`,
        });
      }
      return body.data;
    }).pipe(Effect.scoped, Effect.timeout(Duration.seconds(30)), Effect.mapError(hostError(step)));

  const stopSession = (sessionId: string) =>
    graphql(STOP_SESSION, { id: sessionId }, StoppedSession, "stopping a cloud session").pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Could not stop EAS Simulator session", {
          sessionId,
          cause: error.cause,
        }),
      ),
      Effect.ignore,
    );

  const previewJson = <A extends Schema.Top>(
    origin: string,
    token: string | null,
    route: string,
    schema: A,
  ) =>
    http
      .execute(
        HttpClientRequest.get(`${origin}${route}`).pipe(
          HttpClientRequest.setHeaders(token ? { authorization: `Bearer ${token}` } : {}),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.scoped,
        Effect.timeout(Duration.seconds(15)),
      );

  /** The device a fresh session runs, read from its preview server once it answers. */
  const readDevice = (platform: DevicePlatform, origin: string, token: string | null) =>
    (platform === "ios"
      ? previewJson(origin, token, "/api", IosPreview).pipe(
          Effect.map((preview) => ({
            ...placeholder(config.id, "ios"),
            id: preview.device,
            booted: true,
          })),
        )
      : previewJson(origin, token, "/api/devices", AndroidPreview).pipe(
          Effect.flatMap((preview) => {
            const emulator = preview.emulators[0];
            return emulator
              ? Effect.succeed({
                  ...placeholder(config.id, "android"),
                  id: emulator.id,
                  name: emulator.name,
                  version: emulator.version,
                  booted: true,
                })
              : Effect.fail(
                  new ExpoApiError({ message: "The cloud emulator has not appeared yet." }),
                );
          }),
        )
    ).pipe(Effect.retry({ schedule: Schedule.spaced(POLL_INTERVAL) }));

  /** Newest finished build of the configured profile that still has an installable archive. */
  const latestBuild = (platform: DevicePlatform, profile: string) =>
    graphql(
      LATEST_BUILDS,
      {
        appId: config.projectId,
        filter: {
          platform: platform === "ios" ? "IOS" : "ANDROID",
          status: "FINISHED",
          buildProfile: profile,
          ...(platform === "ios" ? { simulator: true } : {}),
        },
      },
      LatestBuilds,
      "finding a build to install",
    ).pipe(
      Effect.flatMap(({ app }) => {
        const build = app.byId.builds.find(
          (candidate) => candidate.artifacts?.applicationArchiveUrl,
        );
        return build
          ? Effect.succeed(build.id)
          : Effect.fail(
              hostError("finding a build to install")(
                new ExpoApiError({
                  message: `No finished ${platform === "ios" ? "iOS simulator" : "Android"} build of the "${profile}" profile is available. Build one with \`eas build --profile ${profile} --platform ${platform}\`.`,
                }),
              ),
            );
      }),
    );

  const startSession = Effect.fn("EasDeviceHost.startSession")(function* (
    platform: DevicePlatform,
  ) {
    const buildId = config.buildProfile
      ? yield* latestBuild(platform, config.buildProfile)
      : undefined;
    const deviceIdentifier = platform === "ios" ? config.iosDevice : config.androidDevice;
    const created = yield* graphql(
      CREATE_SESSION,
      {
        input: {
          appId: config.projectId,
          name: "T3 Code",
          tags: ["t3code"],
          platform: platform === "ios" ? "IOS" : "ANDROID",
          type: "AGENT_DEVICE",
          maxRunTimeMinutes: EAS_SESSION_MAX_MINUTES,
          maxIdleTimeMinutes: EAS_SESSION_MAX_IDLE_MINUTES,
          ...(buildId ? { buildId } : {}),
          ...(deviceIdentifier ? { [platform]: { deviceIdentifier } } : {}),
        },
      },
      CreatedSession,
      "starting a cloud session",
    );
    const { id, app } = created.deviceRunSession.createDeviceRunSession;
    // Expo's own session page: logs, permissions, and other tools T3 does not proxy.
    const externalUrl = `https://expo.dev/accounts/${encodeURIComponent(app.ownerAccount.name)}/projects/${encodeURIComponent(app.slug)}/simulator-sessions/${encodeURIComponent(id)}`;
    const started = Effect.gen(function* () {
      while (true) {
        const { byId } = (yield* graphql(
          SESSION_STATE,
          { id },
          SessionState,
          "waiting for the cloud session",
        )).deviceRunSessions;
        if (
          ENDED_SESSION_STATUSES.has(byId.status) ||
          ENDED_JOB_STATUSES.has(byId.turtleJobRun?.status ?? "")
        ) {
          return yield* hostError("waiting for the cloud session")(
            new ExpoApiError({
              message: `The cloud session ended before it was ready (${byId.status}).`,
            }),
          );
        }
        const remote = byId.remoteConfig;
        if (
          remote?.agentDeviceRemoteSessionUrl &&
          remote.agentDeviceRemoteSessionToken &&
          remote.previewApiUrl
        ) {
          const previewOrigin = new URL(remote.previewApiUrl).origin;
          const previewToken = remote.webPreviewToken ?? null;
          const device = yield* readDevice(platform, previewOrigin, previewToken).pipe(
            Effect.timeout(PREVIEW_READY_TIMEOUT),
            Effect.mapError(hostError("connecting to the cloud device")),
          );
          return {
            id,
            device: { ...device, externalUrl },
            previewOrigin,
            previewToken,
            agent: {
              baseUrl: remote.agentDeviceRemoteSessionUrl,
              token: remote.agentDeviceRemoteSessionToken,
              entryPath: "",
            },
          } satisfies Session;
        }
        yield* Effect.sleep(POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeout(START_TIMEOUT),
      Effect.mapError((error) =>
        error._tag === "DeviceHostError"
          ? error
          : hostError("waiting for the cloud session")(error),
      ),
    );
    // A session that never became usable still bills until Expo reaps it.
    return yield* started.pipe(Effect.onError(() => stopSession(id)));
  });

  /** Drops sessions Expo already ended (idle or duration caps), so the panel stops offering them. */
  const pruneEnded = Effect.suspend(() =>
    Effect.forEach(
      [...sessions.values()],
      (session) =>
        graphql(SESSION_STATE, { id: session.id }, SessionState, "checking a cloud session").pipe(
          Effect.map(({ deviceRunSessions: { byId } }) => {
            if (
              ENDED_SESSION_STATUSES.has(byId.status) &&
              sessions.get(session.device.platform) === session
            )
              sessions.delete(session.device.platform);
          }),
          Effect.ignore,
        ),
      { concurrency: 2, discard: true },
    ),
  );

  const managed: DeviceHost.ManagedDevices = {
    list: pruneEnded.pipe(
      Effect.map(() =>
        PLATFORMS.map(
          (platform) => sessions.get(platform)?.device ?? placeholder(config.id, platform),
        ),
      ),
    ),
    boot: (device) => {
      const lock = platformLocks.get(device.platform)!;
      return lock.withPermit(
        Effect.gen(function* () {
          const running = sessions.get(device.platform);
          if (running) return running.device.id;
          const started = generation;
          const session = yield* startSession(device.platform);
          if (generation !== started) {
            // The host closed or device support was turned off while Expo queued the start.
            yield* stopSession(session.id);
            return yield* hostError("starting a cloud session")(
              new ExpoApiError({
                message: "Device support stopped while the device was starting.",
              }),
            );
          }
          sessions.set(device.platform, session);
          return session.device.id;
        }),
      );
    },
    // Waits for a start still in Expo's queue, so stopping it does not leave it billing.
    shutdown: (deviceId, platform) =>
      platformLocks.get(platform)!.withPermit(
        Effect.suspend(() => {
          const session = sessions.get(platform);
          if (!session || (session.device.id !== deviceId && deviceId !== platform))
            return Effect.void;
          sessions.delete(platform);
          return stopSession(session.id);
        }),
      ),
    agentDevice: (platform) => Effect.sync(() => sessions.get(platform)?.agent ?? null),
    supportedActions: () => SUPPORTED_ACTIONS,
    action: (device, input) =>
      Effect.gen(function* () {
        const session = sessions.get(device.platform);
        const args = agentDeviceActionArgs(input);
        if (!session || !args)
          return yield* hostError("running the device action")(
            new ExpoApiError({
              message: session
                ? "This cloud device does not support that."
                : "The cloud device is not running.",
            }),
          );
        const nodePath = yield* resolveNodeExecutable("Device automation", environment).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, hostPlatform),
        );
        const tool = yield* ensureAgentDevice(server.baseDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, runner),
        );
        const result = yield* runner.run({
          command: nodePath,
          args: [
            tool.entryPath,
            ...args,
            "--platform",
            device.platform,
            device.platform === "ios" ? "--udid" : "--serial",
            device.id,
            "--json",
          ],
          env: {
            ...environment,
            AGENT_DEVICE_DAEMON_BASE_URL: session.agent.baseUrl,
            AGENT_DEVICE_DAEMON_AUTH_TOKEN: session.agent.token,
          },
          timeout: Duration.minutes(2),
        });
        // With --json, agent-device reports failure in the body, not the exit code.
        const outcome = yield* decodeAgentDeviceResult(result.stdout).pipe(Effect.option);
        const failure = Option.getOrUndefined(outcome);
        if (result.code !== 0 || !failure?.success)
          return yield* new ExpoApiError({
            message:
              failure?.error?.message ??
              (result.stderr.trim().split("\n").at(-1) || `agent-device exited ${result.code}.`),
          });
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "DeviceHostError" ? error : hostError("running the device action")(error),
        ),
      ),
  };

  const ready: DeviceHost.DeviceHostReady = {
    nodePath: "",
    hub: {
      origin: "",
      upstream: (route, search) => {
        const platform = vendorPlatform(route);
        const session = platform ? sessions.get(platform) : undefined;
        return session
          ? easUpstream({ ...session, platform: session.device.platform }, route, search)
          : null;
      },
    },
    run: () =>
      Effect.succeed({
        stdout: "",
        stderr: "Cloud devices do not run host commands.",
        code: 127,
      }),
    helpers: { serveSimAxSettings: null, serveSimCli: null },
  };

  const summary = platforms.pipe(
    Effect.map(
      (available): DeviceHostSummary => ({
        id: config.id,
        label: label(),
        kind: "eas",
        platforms: available,
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
    ),
  );

  const stopAll = Effect.suspend(() => {
    generation++;
    const running = [...sessions.values()];
    sessions.clear();
    return Effect.forEach(running, (session) => stopSession(session.id), {
      concurrency: 2,
      discard: true,
    });
  });
  yield* Effect.addFinalizer(() => stopAll);

  return DeviceHost.DeviceHost.of({
    id: config.id,
    summary,
    platformAvailability: (platform) =>
      platforms.pipe(
        Effect.map(
          (available) =>
            available.find((entry) => entry.platform === platform) ?? {
              platform,
              available: false,
            },
        ),
      ),
    ensureReady: () =>
      credentials.pipe(
        Effect.flatMap((auth) =>
          auth
            ? Effect.succeed(ready)
            : Effect.fail(
                hostError("authenticating with Expo")(
                  new ExpoApiError({ message: "Not signed in to Expo." }),
                ),
              ),
        ),
      ),
    // Agent access is per device here; see `managed.agentDevice`.
    ensureAgentReady: () =>
      Effect.fail(
        hostError("starting agent tools")(
          new ExpoApiError({ message: "Agent access is per cloud device." }),
        ),
      ),
    current: Effect.succeed(ready),
    stopAgent: Effect.void,
    stop: stopAll,
    managed,
  });
});
