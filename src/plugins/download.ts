export interface DownloadRequestV1 {
  readonly filename: string;
  readonly contentType: 'text/plain; charset=utf-8';
  readonly open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

export type DownloadResultV1 =
  | { readonly status: 'saved' | 'delivered-to-browser' | 'cancelled-stream'; readonly bytesWritten: number }
  | { readonly status: 'unavailable'; readonly reason: 'unsupported' | 'inactive' }
  | { readonly status: 'failed'; readonly reason: 'invalid-input' | 'source-failed' | 'sink-failed' | 'transport-failed'; readonly bytesWritten: number };

export interface DownloadServiceV1 {
  readonly version: 1;
  save(input: DownloadRequestV1, signal?: AbortSignal): Promise<DownloadResultV1>;
}
