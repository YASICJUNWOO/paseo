import { beforeEach, describe, expect, it } from "vitest";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import {
  useDownloadStore,
  type Download,
  type DownloadFileOverSession,
} from "@/stores/download-store";
import {
  createFakeDownloadedFileSaver,
  type FakeDownloadedFileSaver,
} from "@/stores/test-utils/fake-save-downloaded-file";

const FILE_BYTES = new TextEncoder().encode("relay download payload");
const FILE_PATH = "reports/데이터.bin";
const FILE_NAME = "데이터.bin";

function fileReadResult(bytes: Uint8Array): FileReadResult {
  return {
    bytes,
    mime: "application/octet-stream",
    size: bytes.byteLength,
    path: FILE_PATH,
    kind: "binary",
    modifiedAt: "2026-05-02T00:00:00.000Z",
  };
}

function rejectTokenRequest(): Promise<never> {
  return Promise.reject(new Error("The session transport must not request an HTTP token."));
}

async function streamWholeFile(
  _path: string,
  onProgress: Parameters<DownloadFileOverSession>[1],
): Promise<FileReadResult> {
  onProgress({ receivedBytes: FILE_BYTES.byteLength / 2, totalBytes: FILE_BYTES.byteLength });
  onProgress({ receivedBytes: FILE_BYTES.byteLength, totalBytes: FILE_BYTES.byteLength });
  return fileReadResult(FILE_BYTES);
}

interface SessionDownloadInput {
  downloadFileOverSession: DownloadFileOverSession;
  saver: FakeDownloadedFileSaver;
}

async function startSessionDownload(input: SessionDownloadInput): Promise<Download | undefined> {
  await useDownloadStore.getState().startDownload({
    serverId: "srv_relay_only",
    scopeId: "workspace-1",
    fileName: FILE_NAME,
    path: FILE_PATH,
    transport: { kind: "session" },
    requestFileDownloadToken: rejectTokenRequest,
    downloadFileOverSession: input.downloadFileOverSession,
    saveDownloadedFile: input.saver.save,
  });
  const { activeDownloadId, downloads } = useDownloadStore.getState();
  return activeDownloadId ? downloads.get(activeDownloadId) : undefined;
}

describe("download store session transport", () => {
  let saver: FakeDownloadedFileSaver;

  beforeEach(() => {
    useDownloadStore.setState({ downloads: new Map(), activeDownloadId: null });
    saver = createFakeDownloadedFileSaver();
  });

  it("streams the file over the session and saves the exact bytes", async () => {
    const requestedPaths: string[] = [];
    const download = await startSessionDownload({
      downloadFileOverSession: (path, onProgress) => {
        requestedPaths.push(path);
        return streamWholeFile(path, onProgress);
      },
      saver,
    });

    expect(requestedPaths).toEqual([FILE_PATH]);
    expect(download).toMatchObject({
      serverId: "srv_relay_only",
      scopeId: "workspace-1",
      fileName: FILE_NAME,
      status: "complete",
      progress: {
        percent: 1,
        bytesWritten: FILE_BYTES.byteLength,
        totalBytes: FILE_BYTES.byteLength,
      },
    });
    expect(saver.savedFiles).toEqual([
      { bytes: FILE_BYTES, mimeType: "application/octet-stream", fileName: FILE_NAME },
    ]);
  });

  it("reports the session error and saves nothing when the transfer fails", async () => {
    const download = await startSessionDownload({
      downloadFileOverSession: async () => {
        throw new Error("File transfer incomplete: expected 10 bytes, received 6.");
      },
      saver,
    });

    expect(download).toMatchObject({
      fileName: FILE_NAME,
      status: "error",
      message: "File transfer incomplete: expected 10 bytes, received 6.",
    });
    expect(saver.savedFiles).toEqual([]);
  });

  it("reports the save error when the transfer succeeds but saving fails", async () => {
    saver.failNextSave(new Error("No download directory available."));

    const download = await startSessionDownload({
      downloadFileOverSession: streamWholeFile,
      saver,
    });

    expect(download).toMatchObject({
      fileName: FILE_NAME,
      status: "error",
      message: "No download directory available.",
    });
    expect(saver.savedFiles).toEqual([]);
  });
});
