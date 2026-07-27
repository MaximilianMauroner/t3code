import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  hydrateRecoveryAttachments,
  recoveryAttachmentUnavailableMessage,
  type RecoveryAttachmentBytesLoader,
  type RecoveryAttachmentSource,
} from "./threadRecoveryAttachments";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function source(id: string, bytes = PNG_BYTES): RecoveryAttachmentSource {
  const attachment: ChatAttachment = {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: bytes.byteLength,
  };
  return { attachment, url: `https://assets.test/${id}` };
}

describe("hydrateRecoveryAttachments", () => {
  it("hydrates the exact bytes for every attachment in order", async () => {
    const loadBytes = vi.fn<RecoveryAttachmentBytesLoader>(async () => ({
      bytes: PNG_BYTES,
      contentType: "image/png; charset=binary",
    }));

    const result = await hydrateRecoveryAttachments({
      sources: [source("one"), source("two")],
      loadBytes,
    });

    expect(result).toEqual({
      kind: "success",
      attachments: ["one", "two"].map((id) => ({
        type: "image",
        name: `${id}.png`,
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.byteLength,
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      })),
    });
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["short", PNG_BYTES.slice(0, -1)],
    ["long", new Uint8Array([...PNG_BYTES, 0])],
  ])("fails closed for a %s download", async (_label, bytes) => {
    const result = await hydrateRecoveryAttachments({
      sources: [source("original")],
      loadBytes: async () => ({ bytes, contentType: "image/png" }),
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "size-mismatch" });
  });

  it("fails closed when the returned MIME type is incompatible", async () => {
    const result = await hydrateRecoveryAttachments({
      sources: [source("original")],
      loadBytes: async () => ({ bytes: PNG_BYTES, contentType: "image/jpeg" }),
    });
    expect(result).toMatchObject({ kind: "unavailable", reason: "mime-mismatch" });
  });

  it("fails closed for corrupt content and download failures with explicit reasons", async () => {
    const corrupt = await hydrateRecoveryAttachments({
      sources: [source("stale")],
      loadBytes: async () => ({
        bytes: new Uint8Array(PNG_BYTES.byteLength),
        contentType: "image/png",
      }),
    });
    expect(corrupt).toMatchObject({ kind: "unavailable", reason: "invalid-content" });
    if (corrupt.kind === "unavailable") {
      expect(recoveryAttachmentUnavailableMessage(corrupt)).toContain("no longer matches");
    }

    const failed = await hydrateRecoveryAttachments({
      sources: [source("offline")],
      loadBytes: async () => {
        throw new Error("offline");
      },
    });
    expect(failed).toMatchObject({ kind: "unavailable", reason: "download-failed" });
  });

  it("returns no attachments when any source fails, preventing partial dispatch", async () => {
    const loadBytes = vi.fn<RecoveryAttachmentBytesLoader>(async ({ attachment }) => {
      if (attachment.id === "two") throw new Error("gone");
      return { bytes: PNG_BYTES, contentType: "image/png" };
    });
    const result = await hydrateRecoveryAttachments({
      sources: [source("one"), source("two"), source("three")],
      loadBytes,
    });

    expect(result).toEqual({
      kind: "unavailable",
      attachmentName: "two.png",
      reason: "download-failed",
    });
    expect(loadBytes).toHaveBeenCalledTimes(2);
    expect("attachments" in result).toBe(false);
  });
});
