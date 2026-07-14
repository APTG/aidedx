/**
 * Thin `getUserMedia` + `MediaRecorder` wrapper: `start()` requests the mic
 * and begins capture, `stop()` ends capture and resolves with the recorded
 * audio as a `Blob` (container/codec is whatever the browser's
 * `MediaRecorder` default is — decoding happens later in `pcm.ts`).
 *
 * Deliberately holds no Svelte/UI state — `asr-status.svelte.ts` owns the
 * idle/recording/transcribing/error state machine and just calls
 * start()/stop() on an instance of this class.
 */

export class MicRecorder {
  #mediaRecorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #stream: MediaStream | null = null;

  get isRecording(): boolean {
    return this.#mediaRecorder !== null;
  }

  /** Requests microphone permission and begins recording. Rejects (e.g. `NotAllowedError`) if permission is denied. */
  async start(): Promise<void> {
    if (this.#mediaRecorder) return;

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    mediaRecorder.start();

    this.#stream = stream;
    this.#mediaRecorder = mediaRecorder;
    this.#chunks = chunks;
  }

  /** Stops recording, releases the mic, and resolves with the captured audio. Throws if not currently recording. */
  async stop(): Promise<Blob> {
    const mediaRecorder = this.#mediaRecorder;
    if (!mediaRecorder) throw new Error("MicRecorder.stop() called while not recording");

    const blob = await new Promise<Blob>((resolve) => {
      mediaRecorder.addEventListener(
        "stop",
        () => resolve(new Blob(this.#chunks, { type: mediaRecorder.mimeType })),
        { once: true },
      );
      mediaRecorder.stop();
    });

    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#mediaRecorder = null;
    this.#chunks = [];
    return blob;
  }
}
