// @effect-diagnostics globalFetch:off globalTimers:off cryptoRandomUUID:off - This browser and WebView transport runs without an Effect runtime.
/* oxlint-disable unicorn/prefer-add-event-listener -- Each session owns its peer connection and handlers. */

/**
 * Receive-only WebRTC video for serve-sim previews that lock their stream
 * transport to WebRTC (EAS cloud simulators answer `stream.avcc` with 409).
 * Signaling is non-trickle: the full offer is POSTed once ICE gathering ends,
 * and the answer comes back in the response body. Decoded frames are handed to
 * `onFrame` from `requestVideoFrameCallback`, so painting only runs while video
 * actually arrives.
 */

const ICE_GATHER_TIMEOUT_MS = 3_000;
const OFFER_ATTEMPTS = 5;
const OFFER_RETRY_DELAY_MS = 1_000;

const CODEC_MIME: Readonly<Record<string, string>> = {
  h264: "video/h264",
  vp9: "video/vp9",
  vp8: "video/vp8",
};

export interface WebRtcStreamSettings {
  readonly codec: string;
  readonly iceServers: RTCIceServer[];
}

/** Read `streamSettings` from serve-sim's `/api` response, defaulting to H.264 and no ICE servers. */
export function parseWebRtcStreamSettings(json: unknown): WebRtcStreamSettings {
  const settings =
    typeof json === "object" && json !== null
      ? (json as { streamSettings?: { codec?: unknown; iceServers?: unknown } }).streamSettings
      : undefined;
  const codec = typeof settings?.codec === "string" ? settings.codec.toLowerCase() : "h264";
  const iceServers = Array.isArray(settings?.iceServers)
    ? settings.iceServers.filter(
        (server): server is RTCIceServer =>
          typeof server === "object" && server !== null && "urls" in server,
      )
    : [];
  return { codec, iceServers };
}

/** Move the codecs matching `codec` to the front, keeping the rest in their original order. */
export function preferCodec<T extends { readonly mimeType: string }>(
  codecs: readonly T[],
  codec: string,
): T[] {
  const mime = CODEC_MIME[codec.toLowerCase()];
  if (!mime) return [...codecs];
  const matches = (entry: T) => entry.mimeType.toLowerCase() === mime;
  return [...codecs.filter(matches), ...codecs.filter((entry) => !matches(entry))];
}

/** A previous viewer's session can still hold the simulator for a moment after it leaves. */
export const isRetryableOfferRejection = (status: number, error: string | undefined): boolean =>
  (status === 409 || status === 503) && (error === undefined || error === "webrtc_session_busy");

/** Why this runtime cannot show a WebRTC device stream, or null when it can. */
export function webRtcVideoUnsupportedReason(): string | null {
  if (typeof RTCPeerConnection === "undefined")
    return "This browser cannot play cloud simulator streams (WebRTC unavailable).";
  if (
    typeof HTMLVideoElement === "undefined" ||
    !("requestVideoFrameCallback" in HTMLVideoElement.prototype)
  )
    return "This browser cannot display the cloud simulator stream.";
  return null;
}

export interface WebRtcVideoOptions {
  /** serve-sim `/api` URL for this device; carries `streamSettings`. */
  readonly apiUrl: string;
  readonly offerUrl: string;
  readonly closeUrl: string;
  readonly credentials: RequestCredentials;
  /** Called once per decoded frame with the playing video element. */
  readonly onFrame: (video: HTMLVideoElement) => void;
  readonly onUnauthorized: () => void;
  /** The session has already been closed; the owner decides whether to reconnect. */
  readonly onFailure: (detail: string) => void;
}

export interface WebRtcVideoSession {
  readonly close: () => void;
}

const randomSessionId = (): string => {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // randomUUID requires a secure context.
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readError = async (response: Response): Promise<string | undefined> => {
  try {
    const body: unknown = JSON.parse(await response.text());
    const error =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : undefined;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
};

const waitForIceGathering = (pc: RTCPeerConnection) =>
  new Promise<void>((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    }
    function check() {
      if (pc.iceGatheringState === "complete") done();
    }
    pc.addEventListener("icegatheringstatechange", check);
  });

/** Start one signaling round and peer connection. Callbacks never fire after `close()`. */
export function openWebRtcVideo(options: WebRtcVideoOptions): WebRtcVideoSession {
  const sessionId = randomSessionId();
  const abort = new AbortController();
  let closed = false;
  let offered = false;
  let pc: RTCPeerConnection | null = null;
  let video: HTMLVideoElement | null = null;
  let frameHandle: number | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    if (video && frameHandle !== null) video.cancelVideoFrameCallback(frameHandle);
    frameHandle = null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    video = null;
    pc?.close();
    pc = null;
    if (offered) {
      void fetch(options.closeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
        credentials: options.credentials,
        keepalive: true,
      }).catch(() => {});
    }
  };

  const failure = (detail: string) => {
    if (closed) return;
    close();
    options.onFailure(detail);
  };

  const unauthorized = () => {
    if (closed) return;
    close();
    options.onUnauthorized();
  };

  const attach = (stream: MediaStream) => {
    if (closed || video) return;
    const element = document.createElement("video");
    element.muted = true;
    element.playsInline = true;
    element.autoplay = true;
    element.srcObject = stream;
    video = element;
    const onVideoFrame = () => {
      if (closed || video !== element) return;
      if (element.videoWidth > 0 && element.videoHeight > 0) options.onFrame(element);
      if (!closed && video === element)
        frameHandle = element.requestVideoFrameCallback(onVideoFrame);
    };
    frameHandle = element.requestVideoFrameCallback(onVideoFrame);
    element.play().catch(() => {});
  };

  const run = async () => {
    const settingsResponse = await fetch(options.apiUrl, {
      signal: abort.signal,
      credentials: options.credentials,
    });
    if (closed) return;
    if (settingsResponse.status === 401 || settingsResponse.status === 403) return unauthorized();
    if (!settingsResponse.ok) throw new Error(`device settings ${settingsResponse.status}`);
    const { codec, iceServers } = parseWebRtcStreamSettings(await settingsResponse.json());
    if (closed) return;

    const connection = new RTCPeerConnection({ iceServers, iceTransportPolicy: "all" });
    pc = connection;
    const transceiver = connection.addTransceiver("video", { direction: "recvonly" });
    const capabilities = RTCRtpReceiver.getCapabilities?.("video");
    if (capabilities && typeof transceiver.setCodecPreferences === "function") {
      try {
        transceiver.setCodecPreferences(preferCodec(capabilities.codecs, codec));
      } catch {
        // The browser's default order still negotiates.
      }
    }
    connection.ontrack = (event) => {
      if (closed || pc !== connection) return;
      event.track.onended = () => failure("Cloud simulator video ended. Reconnecting…");
      attach(event.streams[0] ?? new MediaStream([event.track]));
    };
    connection.onconnectionstatechange = () => {
      if (pc === connection && connection.connectionState === "failed")
        failure("Cloud simulator connection failed. Reconnecting…");
    };

    await connection.setLocalDescription(await connection.createOffer());
    await waitForIceGathering(connection);
    if (closed) return;
    const local = connection.localDescription;
    if (!local) throw new Error("WebRTC offer was not created");

    for (let attempt = 1; ; attempt++) {
      offered = true;
      const response = await fetch(options.offerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: local.type, sdp: local.sdp, sessionId, codec, iceServers }),
        signal: abort.signal,
        credentials: options.credentials,
      });
      if (closed) return;
      if (response.status === 401 || response.status === 403) return unauthorized();
      if (response.ok) {
        const answer = (await response.json()) as RTCSessionDescriptionInit;
        if (closed) return;
        await connection.setRemoteDescription(answer);
        return;
      }
      const error = await readError(response);
      if (closed) return;
      if (attempt >= OFFER_ATTEMPTS || !isRetryableOfferRejection(response.status, error))
        throw new Error(`WebRTC offer ${response.status}${error ? ` ${error}` : ""}`);
      await new Promise((resolve) => setTimeout(resolve, OFFER_RETRY_DELAY_MS));
      if (closed) return;
    }
  };

  void run().catch((cause: unknown) => {
    failure(cause instanceof Error ? cause.message : "Cloud simulator signaling failed.");
  });

  return { close };
}
