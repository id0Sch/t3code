import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type {
  DeviceActionInput,
  DeviceDetail,
  DeviceSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { subscribeDeviceForeground, type DeviceForegroundInfo } from "./deviceHubApi";

type ActionBody = DeviceActionInput extends infer A
  ? A extends { readonly type: string }
    ? Omit<A, "hostId" | "deviceId">
    : never
  : never;

type ActionType = DeviceActionInput["type"];

/** One confirmed settings snapshot and serialized actions for the rail and drawer. Mount keyed by device. */
export function useDeviceControls(options: {
  environmentId: EnvironmentId;
  device: DeviceSummary;
  access: DeviceHubAccess | null;
  visible: boolean;
  /**
   * EAS cloud devices: their preview server serves only the stream, so there is no
   * foreground app, accessibility tree, or event log. Known from the host up front.
   */
  cloud?: boolean;
}) {
  const { environmentId, device, access, visible, cloud = false } = options;
  const readDetail = useAtomCommand(deviceEnvironment.detail, { reportFailure: false });
  const runAction = useAtomCommand(deviceEnvironment.action, { reportFailure: false });
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [foreground, setForeground] = useState<DeviceForegroundInfo | null | undefined>();
  // Hiding invalidates UI results, but does not cancel host commands. Keep them serialized
  // until settlement rather than allowing a reopened panel to race the previous command.
  const busy = useRef(false);
  const generation = useRef(0);
  const visibleRead = useRef<Parameters<typeof readDetail>[0] | null>(null);
  const target = useMemo(
    () => ({ hostId: device.hostId, deviceId: device.id }),
    [device.hostId, device.id],
  );

  useEffect(() => {
    const revision = ++generation.current;
    if (!visible) return;
    const request = { environmentId, input: target };
    visibleRead.current = request;
    void readDetail(request).then((result) => {
      if (generation.current !== revision) return;
      if (result._tag === "Success") {
        setDetail(result.value);
        setError(null);
      } else {
        setDetail(null);
        setError(formatEnvironmentQueryError(result.cause));
      }
    });
    return () => {
      visibleRead.current = null;
      generation.current++;
    };
  }, [environmentId, readDetail, target, visible]);

  useEffect(() => {
    if (!access || !visible || cloud) return;
    let active = true;
    const unsubscribe = subscribeDeviceForeground(
      { access, platform: device.platform, deviceId: device.id },
      (app) => {
        if (active) setForeground(app);
      },
    );
    return () => {
      active = false;
      unsubscribe();
      setForeground(undefined);
    };
  }, [access, cloud, device.id, device.platform, visible]);

  const available = detail !== null && visible;
  const act = async (body: ActionBody) => {
    if (busy.current || !available) return;
    busy.current = true;
    // A settings read started before this action must not overwrite its confirmed result.
    const revision = ++generation.current;
    setPending(true);
    setError(null);
    return runAction({
      environmentId,
      input: { ...target, ...body } as DeviceActionInput,
    })
      .then((result) => {
        if (generation.current !== revision) {
          const request = visibleRead.current;
          if (!request) return;
          // Reopening can read settings before the host command finishes. Confirm them again
          // after it settles, keeping actions serialized through this refresh.
          const refreshRevision = ++generation.current;
          return readDetail(request).then((refreshed) => {
            if (generation.current !== refreshRevision) return;
            if (refreshed._tag === "Success") {
              setDetail(refreshed.value);
              setError(null);
            } else {
              setDetail(null);
              setError(formatEnvironmentQueryError(refreshed.cause));
            }
          });
        }
        if (result._tag === "Success")
          setDetail((previous) => withApplied(previous, result.value, body));
        else setError(formatEnvironmentQueryError(result.cause));
      })
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };

  const supportedActions = detail?.supportedActions;
  return {
    detail,
    cloud,
    /** Whether the device takes this action; devices without a list take every platform action. */
    supports: (type: ActionType) => supportedActions?.includes(type) ?? true,
    /**
     * Whether a setting control is usable. Without an action list a missing read-back value
     * means unsupported; a listed action works without one.
     */
    settable: (type: ActionType, current: unknown) =>
      supportedActions ? supportedActions.includes(type) : current !== undefined,
    pending,
    error,
    act,
    disabled: pending || !detail || !visible,
    foregroundApp: foreground === undefined ? (detail?.foregroundApp ?? null) : foreground,
  };
}

/**
 * Devices without read-back (an action list and empty settings) confirm nothing, so keep the
 * values this panel already applied rather than showing them as unset again.
 */
function withApplied(previous: DeviceDetail | null, next: DeviceDetail, body: ActionBody) {
  if (!next.supportedActions) return next;
  const applied =
    body.type === "setAppearance"
      ? { appearance: body.value }
      : body.type === "setTextSize"
        ? { textSize: body.value }
        : {};
  return { ...next, settings: { ...previous?.settings, ...applied, ...next.settings } };
}

export type DeviceControls = ReturnType<typeof useDeviceControls>;
