import type { ChatAttachment } from "@t3tools/contracts";
import { estimateBase64ByteSize } from "../../lib/base64";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";

export type RecoveryAttachmentHydrationResult =
  | {
      readonly kind: "success";
      readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
    }
  | {
      readonly kind: "unavailable";
      readonly attachmentName: string;
      readonly reason: "missing-url" | "duplicate-source" | "download-failed" | "invalid-content";
    };

export type RecoveryAttachmentDataLoader = (url: string, mimeType: string) => Promise<string>;

export async function loadRecoveryAttachmentDataUrl(
  url: string,
  mimeType: string,
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment request failed with status ${response.status}.`);
  }
  const bytes = await response.arrayBuffer();
  const blob = new Blob([bytes], { type: mimeType });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(new Error("The attachment could not be read.")));
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("The attachment did not produce image data."));
      }
    });
    reader.readAsDataURL(blob);
  });
}

function validDataUrl(dataUrl: string, attachment: ChatAttachment): boolean {
  const separator = dataUrl.indexOf(",");
  if (separator < 0) {
    return false;
  }
  const metadata = dataUrl.slice(0, separator).toLowerCase();
  if (metadata !== `data:${attachment.mimeType.toLowerCase()};base64`) {
    return false;
  }
  return estimateBase64ByteSize(dataUrl.slice(separator + 1)) === attachment.sizeBytes;
}

export async function hydrateRecoveryAttachments(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly urlsByAttachmentId: Readonly<Record<string, string | null | undefined>>;
  readonly loadDataUrl?: RecoveryAttachmentDataLoader;
}): Promise<RecoveryAttachmentHydrationResult> {
  const loadDataUrl = input.loadDataUrl ?? loadRecoveryAttachmentDataUrl;
  const seen = new Set<string>();
  const hydrated: DraftComposerImageAttachment[] = [];

  for (const attachment of input.attachments) {
    if (seen.has(attachment.id)) {
      return {
        kind: "unavailable",
        attachmentName: attachment.name,
        reason: "duplicate-source",
      };
    }
    seen.add(attachment.id);

    const url = input.urlsByAttachmentId[attachment.id];
    if (!url) {
      return { kind: "unavailable", attachmentName: attachment.name, reason: "missing-url" };
    }

    let dataUrl: string;
    try {
      dataUrl = await loadDataUrl(url, attachment.mimeType);
    } catch {
      return { kind: "unavailable", attachmentName: attachment.name, reason: "download-failed" };
    }
    if (!validDataUrl(dataUrl, attachment)) {
      return { kind: "unavailable", attachmentName: attachment.name, reason: "invalid-content" };
    }

    hydrated.push({
      id: `recovery-${attachment.id}`,
      type: "image",
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataUrl,
      previewUri: dataUrl,
    });
  }

  return { kind: "success", attachments: hydrated };
}

export function recoveryAttachmentUnavailableDetail(
  result: Extract<RecoveryAttachmentHydrationResult, { readonly kind: "unavailable" }>,
): string {
  switch (result.reason) {
    case "missing-url":
      return `Retry is unavailable until “${result.attachmentName}” can be loaded.`;
    case "duplicate-source":
      return `Retry is unavailable because “${result.attachmentName}” was recorded more than once.`;
    case "download-failed":
      return `“${result.attachmentName}” could not be downloaded. Try again when the environment is online.`;
    case "invalid-content":
      return `Retry is unavailable because “${result.attachmentName}” no longer matches the original.`;
  }
}
