import { describe, expect, it } from "vite-plus/test";

import {
  isRetryableOfferRejection,
  parseWebRtcStreamSettings,
  preferCodec,
} from "./webrtcVideo.ts";

describe("preferCodec", () => {
  const codecs = [
    { mimeType: "video/VP8" },
    { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f" },
    { mimeType: "video/rtx" },
    { mimeType: "video/H264", sdpFmtpLine: "profile-level-id=640c1f" },
  ];

  it("moves every matching codec first and keeps the remaining order", () => {
    expect(preferCodec(codecs, "h264").map((codec) => codec.mimeType)).toEqual([
      "video/H264",
      "video/H264",
      "video/VP8",
      "video/rtx",
    ]);
  });

  it("leaves the order alone for an unknown codec", () => {
    expect(preferCodec(codecs, "av1")).toEqual(codecs);
  });
});

describe("parseWebRtcStreamSettings", () => {
  it("reads ICE servers and codec from serve-sim's api response", () => {
    const iceServers = [{ urls: "stun:stun.example:3478" }, { urls: ["turn:t"], username: "u" }];
    expect(
      parseWebRtcStreamSettings({
        streamSettings: { transport: "webrtc", codec: "VP9", iceServers: [...iceServers, "bad"] },
      }),
    ).toEqual({ codec: "vp9", iceServers });
  });

  it("defaults to H.264 without ICE servers", () => {
    expect(parseWebRtcStreamSettings({})).toEqual({ codec: "h264", iceServers: [] });
    expect(parseWebRtcStreamSettings(null)).toEqual({ codec: "h264", iceServers: [] });
  });
});

describe("isRetryableOfferRejection", () => {
  it("retries a busy or unexplained conflict and gives up on real errors", () => {
    expect(isRetryableOfferRejection(409, "webrtc_session_busy")).toBe(true);
    expect(isRetryableOfferRejection(503, undefined)).toBe(true);
    expect(isRetryableOfferRejection(409, "stream_transport_locked")).toBe(false);
    expect(isRetryableOfferRejection(500, undefined)).toBe(false);
  });
});
