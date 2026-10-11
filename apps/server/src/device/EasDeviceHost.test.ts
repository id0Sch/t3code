import { describe, expect, it } from "@effect/vitest";
import { type DeviceSummary, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as NetService from "@t3tools/shared/Net";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import { agentDeviceActionArgs, easUpstream } from "./EasDeviceHost.ts";

describe("easUpstream", () => {
  const ios = { platform: "ios", previewOrigin: "https://ios.preview", previewToken: "t" } as const;
  const android = {
    platform: "android",
    previewOrigin: "https://android.preview",
    previewToken: null,
  } as const;

  it("serves iOS hub routes from serve-sim's root with the session token", () => {
    expect(
      easUpstream(ios, "/vendor/serve-sim/helper/ws", new URLSearchParams({ device: "U-1" })),
    ).toEqual({
      url: "https://ios.preview/helper/U-1/ws",
      headers: { authorization: "Bearer t" },
      protocols: ["serve-sim.token.t"],
    });
    expect(
      easUpstream(ios, "/vendor/serve-sim/api/screenshot", new URLSearchParams({ device: "U-1" }))
        ?.url,
    ).toBe("https://ios.preview/api/screenshot?device=U-1");
  });

  it("passes Android hub routes through and refuses the other platform's", () => {
    expect(
      easUpstream(
        android,
        "/vendor/serve-emu/ws",
        new URLSearchParams({ device: "emulator-5554" }),
      ),
    ).toEqual({ url: "https://android.preview/vendor/serve-emu/ws?device=emulator-5554" });
    expect(easUpstream(android, "/vendor/serve-sim/api", new URLSearchParams())).toBeNull();
    expect(easUpstream(ios, "/api/devices", new URLSearchParams())).toBeNull();
  });
});

describe("agentDeviceActionArgs", () => {
  it("maps drawer actions onto agent-device commands", () => {
    expect(
      agentDeviceActionArgs({
        deviceId: "d",
        type: "setPermission",
        appId: "io.guard",
        permission: "camera",
        decision: "revoke",
      }),
    ).toEqual(["settings", "permission", "deny", "camera", "--app", "io.guard"]);
    expect(
      agentDeviceActionArgs({ deviceId: "d", type: "sendPush", appId: "io.guard", payload: "hi" }),
    ).toEqual(["push", "io.guard", '{"aps":{"alert":"hi"}}']);
  });

  it("refuses what agent-device cannot do", () => {
    expect(agentDeviceActionArgs({ deviceId: "d", type: "shake" })).toBeNull();
    // Orientation needs an open agent-device session; the panel rotates iOS over the stream instead.
    expect(
      agentDeviceActionArgs({ deviceId: "d", type: "setOrientation", value: "landscape_left" }),
    ).toBeNull();
    expect(
      agentDeviceActionArgs({
        deviceId: "d",
        type: "setPermission",
        appId: "io.guard",
        permission: "faceid",
        decision: "grant",
      }),
    ).toBeNull();
  });
});

it.effect("starts a cloud device on open and stops it when its last viewer closes", () =>
  Effect.gen(function* () {
    const placeholder: DeviceSummary = {
      hostId: "eas",
      id: "ios",
      platform: "ios",
      name: "iOS Simulator",
      version: "EAS",
      booted: false,
      physical: false,
    };
    let running: DeviceSummary | null = null;
    const stopped: string[] = [];
    const endpoint = { baseUrl: "https://agent.eas", token: "secret", entryPath: "" };
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: "",
      hub: { origin: "", upstream: () => null },
      run: () => Effect.succeed({ stdout: "", stderr: "", code: 127 }),
      helpers: { serveSimAxSettings: null, serveSimCli: null },
    };
    const host: DeviceHost.DeviceHost["Service"] = {
      id: "eas",
      summary: Effect.succeed({
        id: "eas",
        label: "EAS",
        kind: "eas",
        hubInstalled: true,
        agentDeviceInstalled: true,
        platforms: [{ platform: "ios", available: true }],
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () => Effect.die("agent access is per device"),
      current: Effect.succeed(ready),
      stopAgent: Effect.void,
      stop: Effect.void,
      managed: {
        list: Effect.sync(() => [running ?? placeholder]),
        boot: () =>
          Effect.sync(() => {
            running = { ...placeholder, id: "UDID-1", booted: true };
            return running.id;
          }),
        shutdown: (deviceId) =>
          Effect.sync(() => {
            stopped.push(deviceId);
            running = null;
          }),
        agentDevice: () => Effect.sync(() => (running ? endpoint : null)),
        supportedActions: () => [],
        action: () => Effect.void,
      },
    };
    const configs: Array<{ key: string; baseUrl: string }> = [];
    const service = yield* DeviceService.makeWithHosts(
      new Map([["eas", host]]),
      undefined,
      (key, value) =>
        Effect.sync(() => {
          configs.push({ key, baseUrl: value.agentDevice.baseUrl });
          return `/configs/${key}.json`;
        }),
    ).pipe(
      Effect.provide(NodeCrypto.layer),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
        ),
      ),
    );

    const first = ThreadId.make("first");
    const second = ThreadId.make("second");
    yield* service.list;
    // Consent comes before boot, so the agent config exists before the daemon does.
    const args = yield* service.agentTarget({ threadId: first, hostId: "eas", deviceId: "ios" });
    expect(args.slice(0, 2)).toEqual(["--config", "/configs/eas/ios.json"]);
    const session = yield* service.open({
      threadId: first,
      hostId: "eas",
      deviceId: "ios",
      platform: "ios",
    });
    expect(session.deviceId).toBe("UDID-1");
    expect(configs).toEqual([
      { key: "eas/ios", baseUrl: "" },
      { key: "eas/ios", baseUrl: "https://agent.eas" },
    ]);

    yield* service.open({ threadId: second, hostId: "eas", deviceId: "UDID-1", platform: "ios" });
    yield* service.close({ threadId: first, hostId: "eas", deviceId: "UDID-1" });
    expect(stopped).toEqual([]);
    yield* service.close({ threadId: second, hostId: "eas", deviceId: "UDID-1" });
    expect(stopped).toEqual(["UDID-1"]);
    expect((yield* service.state).devices.map((device) => device.id)).toEqual(["ios"]);

    // Revoking agent access cannot stop a cloud daemon, so it points the agent config nowhere.
    configs.length = 0;
    yield* service.configure({ agentAccessEnabled: false });
    expect(configs).toEqual([
      { key: "eas/ios", baseUrl: "" },
      { key: "eas/android", baseUrl: "" },
    ]);
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);

/** A fake Expo API: one session whose status the test controls. */
const fakeExpo = (control: {
  status: string;
  stopped: Array<string>;
  beforeReady?: Deferred.Deferred<void>;
  /** Completed once a start is waiting on `beforeReady`. */
  waiting?: Deferred.Deferred<void>;
}) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const json = (body: unknown) => HttpClientResponse.fromWeb(request, Response.json(body));
      if (request.url === "https://preview.eas/api") return json({ device: "UDID-1" });
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      if (body.includes("T3CreateDeviceRunSession"))
        return json({
          data: {
            deviceRunSession: {
              createDeviceRunSession: {
                id: "session-1",
                app: { slug: "app", ownerAccount: { name: "acme" } },
              },
            },
          },
        });
      if (body.includes("T3StopDeviceRunSession")) {
        control.stopped.push("session-1");
        return json({
          data: { deviceRunSession: { ensureDeviceRunSessionStopped: { id: "session-1" } } },
        });
      }
      if (control.waiting) yield* Deferred.succeed(control.waiting, undefined);
      if (control.beforeReady) yield* Deferred.await(control.beforeReady);
      return json({
        data: {
          deviceRunSessions: {
            byId: {
              status: control.status,
              turtleJobRun: { status: "IN_PROGRESS" },
              remoteConfig: {
                agentDeviceRemoteSessionUrl: "https://agent.eas",
                agentDeviceRemoteSessionToken: "agent-token",
                webPreviewToken: "preview-token",
                previewApiUrl: "https://preview.eas/?token=preview-token",
              },
            },
          },
        },
      });
    }),
  );

describe("EasDeviceHost", () => {
  const config = { id: "eas", label: "EAS", projectId: "project", accessToken: "token" };
  const ios: DeviceSummary = {
    hostId: "eas",
    id: "ios",
    platform: "ios",
    name: "iOS Simulator",
    version: "EAS",
    booted: false,
    physical: false,
  };

  const withHost = <A, E>(
    control: Parameters<typeof fakeExpo>[0],
    body: (host: DeviceHost.DeviceHost["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const host = yield* EasDeviceHost.make(config).pipe(
        Effect.provide(ServerConfig.layerTest(dir, dir)),
        Effect.provide(ProcessRunner.layer),
        Effect.provideService(HttpClient.HttpClient, fakeExpo(control)),
      );
      return yield* body(host);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("stops offering a device once Expo ends its session", () => {
    const control = { status: "IN_PROGRESS", stopped: [] as Array<string> };
    return withHost(control, (host) =>
      Effect.gen(function* () {
        expect(yield* host.managed!.boot(ios)).toBe("UDID-1");
        const running = (yield* host.managed!.list).find((device) => device.platform === "ios");
        expect(running).toMatchObject({ id: "UDID-1", booted: true, transport: "webrtc" });
        // Expo's idle cap ended it; the next list must offer a fresh start, not the dead device.
        control.status = "STOPPED";
        const after = (yield* host.managed!.list).find((device) => device.platform === "ios");
        expect(after).toMatchObject({ id: "ios", booted: false });
      }),
    );
  });

  it.effect("a start that finishes after the host stops does not keep billing", () =>
    Effect.gen(function* () {
      const control = {
        status: "IN_PROGRESS",
        stopped: [] as Array<string>,
        beforeReady: yield* Deferred.make<void>(),
        waiting: yield* Deferred.make<void>(),
      };
      yield* withHost(control, (host) =>
        Effect.gen(function* () {
          const booting = yield* host.managed!.boot(ios).pipe(Effect.forkChild);
          yield* Deferred.await(control.waiting);
          yield* host.stop;
          yield* Deferred.succeed(control.beforeReady, undefined);
          const exit = yield* Fiber.await(booting);
          expect(exit._tag).toBe("Failure");
          expect(control.stopped).toEqual(["session-1"]);
          const after = (yield* host.managed!.list).find((device) => device.platform === "ios");
          expect(after).toMatchObject({ id: "ios", booted: false });
        }),
      );
    }),
  );

  it.effect("a stop issued while the session is starting waits and stops it", () =>
    Effect.gen(function* () {
      const control = {
        status: "IN_PROGRESS",
        stopped: [] as Array<string>,
        beforeReady: yield* Deferred.make<void>(),
      };
      yield* withHost(control, (host) =>
        Effect.gen(function* () {
          const booting = yield* host.managed!.boot(ios).pipe(Effect.forkChild);
          const stopping = yield* host.managed!.shutdown("ios", "ios").pipe(Effect.forkChild);
          yield* Deferred.succeed(control.beforeReady, undefined);
          yield* Fiber.join(booting);
          yield* Fiber.join(stopping);
          expect(control.stopped).toEqual(["session-1"]);
          const after = (yield* host.managed!.list).find((device) => device.platform === "ios");
          expect(after).toMatchObject({ id: "ios", booted: false });
        }),
      );
    }),
  );
});

it.effect("renaming an EAS project keeps its running cloud session", () =>
  Effect.gen(function* () {
    const control = { status: "IN_PROGRESS", stopped: [] as Array<string> };
    const local: DeviceHost.DeviceHost["Service"] = {
      id: "local",
      summary: Effect.succeed({
        id: "local",
        label: "This machine",
        kind: "local",
        hubInstalled: false,
        agentDeviceInstalled: false,
        platforms: [],
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: false }),
      ensureReady: () => Effect.die("no local devices"),
      ensureAgentReady: () => Effect.die("no local devices"),
      current: Effect.succeed(null),
      stopAgent: Effect.void,
      stop: Effect.void,
    };
    const project = { id: "eas", label: "Guardio", projectId: "project", accessToken: "token" };
    yield* Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({ enableDeviceSupport: true, easDeviceHosts: [project] });
      const service = yield* DeviceService.make;
      const threadId = ThreadId.make("thread");
      yield* service.list;
      yield* service.open({ threadId, hostId: "eas", deviceId: "ios", platform: "ios" });

      const updates = yield* service.subscribe;
      yield* settings.updateSettings({ easDeviceHosts: [{ ...project, label: "Renamed" }] });
      // The rename is published once the settings reconcile has run.
      yield* Stream.fromSubscription(updates).pipe(
        Stream.filter((state) => state.hosts.some((host) => host.label === "Renamed")),
        Stream.runHead,
      );
      const state = yield* service.state;
      expect(control.stopped).toEqual([]);
      expect(state.sessions.map((session) => session.deviceId)).toEqual(["UDID-1"]);
    }).pipe(
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(
            Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-eas-rename-" })),
          ),
        ),
      ),
      Effect.provide(ProcessRunner.layer),
      Effect.provide(NetService.layer),
      Effect.provideService(DeviceHost.DeviceHost, local),
      Effect.provideService(HttpClient.HttpClient, fakeExpo(control)),
      Effect.provide(NodeCrypto.layer),
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    );
  }),
);
