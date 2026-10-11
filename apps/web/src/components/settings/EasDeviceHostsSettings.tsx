import { AuthSettingsWriteScope } from "@t3tools/contracts";
import type { EasDeviceHostConfig, EnvironmentId } from "@t3tools/contracts";
import { MoreVertical, PlusIcon } from "lucide-react";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useDeviceState } from "../../state/device";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { SAVED_SECRET_MARKER, updateEasDeviceHosts } from "./deviceHostsSettings.logic";
import { useSaveDeviceHostsOnEnvironments } from "./DeviceHostsSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow } from "./settingsLayout";

/** EAS Simulator accounts, saved to every selected environment like SSH device hosts. */
export function EasDeviceHostsSettings(props: { environmentId: EnvironmentId | null }) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const canConfigure = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  const saveOnEnvironments = useSaveDeviceHostsOnEnvironments();
  const [editing, setEditing] = useState<EasDeviceHostConfig | null>(null);
  const [originalHost, setOriginalHost] = useState<EasDeviceHostConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (host: EasDeviceHostConfig, remove = false, original = host) => {
    if (!props.environmentId || projectScope) return;
    setBusy(true);
    try {
      const saved = await saveOnEnvironments((settings) => ({
        easDeviceHosts: updateEasDeviceHosts(
          settings.easDeviceHosts,
          settings.deviceHosts,
          host,
          remove,
          randomUUID,
          original,
        ),
      }));
      if (saved) setEditing(null);
    } finally {
      setBusy(false);
    }
  };
  const disabled = !canConfigure || projectScope || busy;
  return (
    <SettingsRow
      id="eas-device-hosts"
      title="EAS Simulator"
      serverScoped
      settingKeys={["easDeviceHosts"]}
      description="Open Expo's cloud iOS simulators and Android emulators from the Device panel. Opening a device starts a billed cloud session that T3 Code stops when you close it, after 15 idle minutes, or after 60 minutes."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !props.environmentId || editing !== null}
          onClick={() => {
            setOriginalHost(null);
            setEditing({ id: randomUUID(), label: "", projectId: "", accessToken: "" });
          }}
        >
          <PlusIcon className="size-3.5" /> Add project
        </Button>
      }
    >
      <div className="pt-3 pb-2">
        {!props.environmentId ? (
          <p className="text-sm text-muted-foreground">
            Connect a selected environment to manage EAS Simulator projects.
          </p>
        ) : (
          <>
            {connectedEnvironments.map((environment) => (
              <div key={environment.environmentId}>
                {connectedEnvironments.length > 1 ? (
                  <p className="pt-3 pb-1 text-xs font-medium text-muted-foreground">
                    {environment.label}
                  </p>
                ) : null}
                <EasDeviceHostList
                  environmentId={environment.environmentId}
                  hosts={environment.serverConfig?.settings.easDeviceHosts ?? []}
                  busy={disabled}
                  onEdit={(host) => {
                    setOriginalHost(host);
                    setEditing(host);
                  }}
                  onRemove={(host) => void save(host, true)}
                />
              </div>
            ))}
            {editing ? (
              <EasDeviceHostEditor
                key={editing.id}
                host={editing}
                isNew={originalHost === null}
                busy={busy}
                onSave={(host) => void save(host, false, originalHost ?? host)}
                onClose={() => setEditing(null)}
              />
            ) : null}
          </>
        )}
      </div>
    </SettingsRow>
  );
}

function EasDeviceHostList(props: {
  environmentId: EnvironmentId;
  hosts: ReadonlyArray<EasDeviceHostConfig>;
  busy: boolean;
  onEdit: (host: EasDeviceHostConfig) => void;
  onRemove: (host: EasDeviceHostConfig) => void;
}) {
  const { state } = useDeviceState(props.environmentId);
  if (props.hosts.length === 0) {
    return <p className="py-2 text-sm text-muted-foreground">No EAS Simulator projects.</p>;
  }
  return props.hosts.map((host) => {
    const status = state.hostStatuses[host.id];
    return (
      <div key={host.id} className="flex items-center gap-2 border-t border-border/50 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{host.label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {host.projectId} ·{" "}
            {host.accessToken ? "Access token saved" : "Uses the server's Expo login"}
          </p>
          {status?.status === "failed" && status.detail ? (
            <details role="status" className="mt-1 text-xs text-destructive">
              <summary>EAS Simulator unavailable</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{status.detail}</p>
            </details>
          ) : null}
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                disabled={props.busy}
                aria-label={host.label + " options"}
              />
            }
          >
            <MoreVertical />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => props.onEdit(host)}>Edit</MenuItem>
            <MenuItem variant="destructive" onClick={() => props.onRemove(host)}>
              Remove
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  });
}

function EasDeviceHostEditor(props: {
  host: EasDeviceHostConfig;
  isNew: boolean;
  busy: boolean;
  onSave: (host: EasDeviceHostConfig) => void;
  onClose: () => void;
}) {
  const { host, busy } = props;
  const [draft, setDraft] = useState(host);
  const [tokenRemoved, setTokenRemoved] = useState(false);
  const tokenSaved = draft.accessToken === SAVED_SECRET_MARKER;
  const valid = draft.label.trim().length > 0 && draft.projectId.trim().length > 0;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup
        showCloseButton={!busy}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || busy) return;
              const { buildProfile, iosDevice, androidDevice, ...required } = draft;
              props.onSave({
                ...required,
                label: draft.label.trim(),
                projectId: draft.projectId.trim(),
                accessToken: draft.accessToken.trim(),
                ...optionalField("buildProfile", buildProfile),
                ...optionalField("iosDevice", iosDevice),
                ...optionalField("androidDevice", androidDevice),
              });
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>
            {props.isNew ? "Add EAS Simulator project" : "Edit EAS Simulator project"}
          </DialogTitle>
          <DialogDescription>
            Opening one of its devices starts a billed cloud session. T3 Code stops it when you
            close the device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              autoFocus
              required
              value={draft.label}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              placeholder="My app"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>EAS project ID</span>
            <Input
              required
              value={draft.projectId}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
            <span className="block text-xs text-muted-foreground">
              Found as extra.eas.projectId in your app config, or on the project page on expo.dev.
            </span>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Access token</span>
            <Input
              type="password"
              autoComplete="off"
              // A saved token never shows; an emptied field keeps it.
              value={tokenSaved ? "" : draft.accessToken}
              disabled={busy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  accessToken:
                    event.target.value === "" && !tokenRemoved
                      ? host.accessToken
                      : event.target.value,
                })
              }
              placeholder={tokenSaved ? "Saved. Enter a new token to replace it" : "Optional"}
            />
            <span className="block text-xs text-muted-foreground">
              Optional. Without a token, the server uses EXPO_TOKEN or its eas login. Create one at
              expo.dev → Account settings → Access tokens.
            </span>
          </label>
          {tokenSaved ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setTokenRemoved(true);
                setDraft({ ...draft, accessToken: "" });
              }}
            >
              Remove saved token
            </Button>
          ) : null}
          <label className="block space-y-1.5 text-sm">
            <span>Build profile</span>
            <Input
              value={draft.buildProfile ?? ""}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, buildProfile: event.target.value })}
              placeholder="development:simulator"
            />
            <span className="block text-xs text-muted-foreground">
              Installs the newest finished build of this profile when a device starts. iOS needs a
              simulator build.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5 text-sm">
              <span>iOS device</span>
              <Input
                value={draft.iosDevice ?? ""}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, iosDevice: event.target.value })}
                placeholder="iPhone 17 Pro"
              />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Android device</span>
              <Input
                value={draft.androidDevice ?? ""}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, androidDevice: event.target.value })}
                placeholder="pixel_7"
              />
            </label>
          </div>
          <span className="block text-xs text-muted-foreground">
            Expo picks a device when empty.
          </span>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !valid}>
            {busy ? <Spinner size="xs" /> : null} Save project
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A trimmed optional setting, omitted when empty. */
function optionalField<K extends string>(key: K, value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? ({ [key]: trimmed } as Record<K, string>) : {};
}
