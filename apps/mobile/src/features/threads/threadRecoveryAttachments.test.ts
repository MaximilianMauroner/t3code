import type { ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { hydrateRecoveryAttachments } from "./threadRecoveryAttachments";

const attachments: ReadonlyArray<ChatAttachment> = [
  {
    type: "image",
    id: "image-one",
    name: "one.png",
    mimeType: "image/png",
    sizeBytes: 3,
  },
  {
    type: "image",
    id: "image-two",
    name: "two.png",
    mimeType: "image/png",
    sizeBytes: 3,
  },
];

describe("hydrateRecoveryAttachments", () => {
  it("hydrates every exact source once and preserves order", async () => {
    const loadDataUrl = vi.fn(async () => "data:image/png;base64,YWJj");
    const result = await hydrateRecoveryAttachments({
      attachments,
      urlsByAttachmentId: {
        "image-one": "https://assets.test/one",
        "image-two": "https://assets.test/two",
      },
      loadDataUrl,
    });

    expect(result).toMatchObject({
      kind: "success",
      attachments: [
        { name: "one.png", dataUrl: "data:image/png;base64,YWJj" },
        { name: "two.png", dataUrl: "data:image/png;base64,YWJj" },
      ],
    });
    expect(loadDataUrl.mock.calls).toEqual([
      ["https://assets.test/one", "image/png"],
      ["https://assets.test/two", "image/png"],
    ]);
  });

  it("fails closed when an asset URL is missing", async () => {
    const loadDataUrl = vi.fn(async () => "data:image/png;base64,YWJj");
    expect(
      await hydrateRecoveryAttachments({
        attachments,
        urlsByAttachmentId: { "image-one": "https://assets.test/one" },
        loadDataUrl,
      }),
    ).toEqual({
      kind: "unavailable",
      attachmentName: "two.png",
      reason: "missing-url",
    });
    expect(loadDataUrl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on download errors or changed bytes", async () => {
    expect(
      await hydrateRecoveryAttachments({
        attachments: [attachments[0]!],
        urlsByAttachmentId: { "image-one": "https://assets.test/one" },
        loadDataUrl: async () => {
          throw new Error("offline");
        },
      }),
    ).toMatchObject({ kind: "unavailable", reason: "download-failed" });
    expect(
      await hydrateRecoveryAttachments({
        attachments: [attachments[0]!],
        urlsByAttachmentId: { "image-one": "https://assets.test/one" },
        loadDataUrl: async () => "data:image/png;base64,Zm91cg==",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "invalid-content" });
  });

  it("rejects duplicate descriptors instead of uploading twice", async () => {
    const loadDataUrl = vi.fn(async () => "data:image/png;base64,YWJj");
    expect(
      await hydrateRecoveryAttachments({
        attachments: [attachments[0]!, attachments[0]!],
        urlsByAttachmentId: { "image-one": "https://assets.test/one" },
        loadDataUrl,
      }),
    ).toMatchObject({ kind: "unavailable", reason: "duplicate-source" });
    expect(loadDataUrl).toHaveBeenCalledTimes(1);
  });
});
