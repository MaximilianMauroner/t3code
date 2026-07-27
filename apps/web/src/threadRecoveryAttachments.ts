import type { ChatAttachment } from "@t3tools/contracts";

export interface RecoveryAttachmentSource {
  readonly attachment: ChatAttachment;
  readonly url: string;
}

export interface RecoveryAttachmentBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

export type RecoveryAttachmentBytesLoader = (
  source: RecoveryAttachmentSource,
) => Promise<RecoveryAttachmentBytes>;

export interface HydratedRecoveryAttachment {
  readonly type: "image";
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

export type RecoveryAttachmentHydrationResult =
  | {
      readonly kind: "success";
      readonly attachments: ReadonlyArray<HydratedRecoveryAttachment>;
    }
  | {
      readonly kind: "unavailable";
      readonly attachmentName: string;
      readonly reason:
        | "duplicate-source"
        | "download-failed"
        | "size-mismatch"
        | "mime-mismatch"
        | "invalid-content";
    };

function normalizedMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function startsWith(bytes: Uint8Array, signature: ReadonlyArray<number>): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function contentMatchesMimeType(bytes: Uint8Array, mimeType: string): boolean {
  switch (normalizedMimeType(mimeType)) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return (
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return true;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(""));
}

export async function fetchRecoveryAttachmentBytes(
  source: RecoveryAttachmentSource,
): Promise<RecoveryAttachmentBytes> {
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new Error(`Attachment request failed with status ${response.status}.`);
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type"),
  };
}

export async function hydrateRecoveryAttachments(input: {
  readonly sources: ReadonlyArray<RecoveryAttachmentSource>;
  readonly loadBytes?: RecoveryAttachmentBytesLoader;
}): Promise<RecoveryAttachmentHydrationResult> {
  const loadBytes = input.loadBytes ?? fetchRecoveryAttachmentBytes;
  const seen = new Set<string>();
  const attachments: HydratedRecoveryAttachment[] = [];

  for (const source of input.sources) {
    const { attachment } = source;
    if (seen.has(attachment.id)) {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "duplicate-source",
      };
    }
    seen.add(attachment.id);

    let loaded: RecoveryAttachmentBytes;
    try {
      loaded = await loadBytes(source);
    } catch {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "download-failed",
      };
    }

    if (loaded.bytes.byteLength !== attachment.sizeBytes) {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "size-mismatch",
      };
    }
    if (
      loaded.contentType !== null &&
      normalizedMimeType(loaded.contentType) !== normalizedMimeType(attachment.mimeType)
    ) {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "mime-mismatch",
      };
    }
    if (!contentMatchesMimeType(loaded.bytes, attachment.mimeType)) {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "invalid-content",
      };
    }

    attachments.push({
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl: `data:${attachment.mimeType};base64,${bytesToBase64(loaded.bytes)}`,
    });
  }

  return { kind: "success", attachments };
}

export function recoveryAttachmentUnavailableMessage(
  result: Extract<RecoveryAttachmentHydrationResult, { readonly kind: "unavailable" }>,
): string {
  switch (result.reason) {
    case "duplicate-source":
      return `Retry is unavailable because “${result.attachmentName}” was recorded more than once.`;
    case "download-failed":
      return `Retry is unavailable because “${result.attachmentName}” could not be downloaded.`;
    case "size-mismatch":
    case "mime-mismatch":
    case "invalid-content":
      return `Retry is unavailable because “${result.attachmentName}” no longer matches the original attachment.`;
  }
}
