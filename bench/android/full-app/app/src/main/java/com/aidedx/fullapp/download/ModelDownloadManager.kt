package com.aidedx.fullapp.download

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * issue #136 goal 1 — explicit, user-initiated model download, offline-maps-style: nothing here
 * is ever called except in direct response to a user tap (see `MainActivity`). No SvelteKit/
 * Android-framework dependency beyond `java.net`/`java.io` — same framework-free split as the web
 * app's `src/lib/models/download.ts`, which this mirrors the *shape* of (a `FileProgress`-like
 * progress callback, sequential per-file download, explicit cancellation), translated from
 * transformers.js's own progress events to plain `HttpURLConnection` streaming since there is no
 * transformers.js equivalent on Android — this fetches the same 4 sherpa-onnx model files
 * (encoder/decoder/joiner + tokens.txt) mirrored to the same Cyfronet bucket
 * (`docs/model-hosting-cyfronet.md`), not an ONNX-community HF repo.
 */
data class ModelFile(val remoteUrl: String, val fileName: String, val sizeBytes: Long)

data class ModelEntry(
    val id: String,
    val displayName: String,
    val sourceHost: String,
    val destDirName: String,
    val files: List<ModelFile>,
) {
    val totalSizeBytes: Long get() = files.sumOf { it.sizeBytes }
}

/** issue #136 goal 1 — the one entry this spike's download UX manages (NeMo Parakeet-v3 int8,
 * goal 2's ASR model). Mirrored to Cyfronet per docs/model-hosting-cyfronet.md's existing
 * whisper-small mirror convention — see docs/android-full-app-spike.md for the mirroring step. */
object ParakeetModel {
    private const val MIRROR_BASE =
        "https://aidedx-models.s3p.cloud.cyfronet.pl/csukuangfj/" +
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/"

    val ENTRY = ModelEntry(
        id = "parakeet-v3-int8",
        displayName = "NeMo Parakeet-v3 (int8)",
        sourceHost = "aidedx-models.s3p.cloud.cyfronet.pl",
        destDirName = "model-parakeet",
        files = listOf(
            ModelFile(MIRROR_BASE + "encoder.int8.onnx", "encoder.int8.onnx", 652_184_281L),
            ModelFile(MIRROR_BASE + "decoder.int8.onnx", "decoder.int8.onnx", 11_845_275L),
            ModelFile(MIRROR_BASE + "joiner.int8.onnx", "joiner.int8.onnx", 6_355_277L),
            ModelFile(MIRROR_BASE + "tokens.txt", "tokens.txt", 93_939L),
        ),
    )
}

data class DownloadProgress(
    val fileName: String,
    val loadedBytes: Long,
    val totalBytes: Long,
    val done: Boolean,
)

class DownloadCancelledException : IOException("Model download was cancelled")

/** Runs entirely on the calling thread — callers must invoke `download()` from a background
 * thread (see `MainActivity`, which uses a plain `Thread`, matching every other bench app's
 * no-coroutines convention). */
class ModelDownloadManager(private val filesDir: File) {

    @Volatile private var cancelled = false
    @Volatile private var activeConnection: HttpURLConnection? = null

    fun isDownloaded(entry: ModelEntry): Boolean {
        val dir = File(filesDir, entry.destDirName)
        return entry.files.all { File(dir, it.fileName).length() == it.sizeBytes }
    }

    fun sizeOnDiskBytes(entry: ModelEntry): Long {
        val dir = File(filesDir, entry.destDirName)
        if (!dir.exists()) return 0L
        return dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
    }

    fun storageLocationLabel(entry: ModelEntry): String =
        "App storage / ${entry.destDirName}"

    /** Aborts as soon as possible: sets the cancel flag (checked between read() calls) AND
     * force-disconnects the in-flight connection so a stalled/slow read() unblocks immediately
     * rather than waiting out its own read timeout. Always cleans up the partial file — see
     * download()'s catch block. */
    fun cancel() {
        cancelled = true
        activeConnection?.disconnect()
    }

    fun delete(entry: ModelEntry) {
        File(filesDir, entry.destDirName).deleteRecursively()
    }

    @Throws(IOException::class)
    fun download(entry: ModelEntry, onProgress: (DownloadProgress) -> Unit) {
        cancelled = false
        val dir = File(filesDir, entry.destDirName)
        dir.mkdirs()
        val totalBytes = entry.totalSizeBytes
        var loadedSoFar = 0L

        for (file in entry.files) {
            val dest = File(dir, file.fileName)
            if (dest.exists() && dest.length() == file.sizeBytes) {
                loadedSoFar += file.sizeBytes
                onProgress(DownloadProgress(file.fileName, loadedSoFar, totalBytes, true))
                continue
            }

            if (cancelled) throw DownloadCancelledException()

            val partial = File(dir, file.fileName + ".part")
            val connection = URL(file.remoteUrl).openConnection() as HttpURLConnection
            activeConnection = connection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.connect()
                if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                    throw IOException("HTTP ${connection.responseCode} fetching ${file.remoteUrl}")
                }

                var fileLoaded = 0L
                connection.inputStream.use { input ->
                    FileOutputStream(partial).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            if (cancelled) throw DownloadCancelledException()
                            val read = input.read(buffer)
                            if (read == -1) break
                            output.write(buffer, 0, read)
                            fileLoaded += read
                            onProgress(
                                DownloadProgress(file.fileName, loadedSoFar + fileLoaded, totalBytes, false),
                            )
                        }
                    }
                }
            } catch (e: IOException) {
                partial.delete()
                // A cancel-triggered disconnect() aborts the in-flight read() with a plain
                // IOException ("Socket closed"), racing ahead of the `cancelled` flag check on
                // the next loop iteration — surface it as a real cancellation, not a mislabeled
                // "Download failed: Socket closed" (confirmed on-device: without this check, a
                // deliberate Cancel tap showed exactly that misleading error text).
                if (cancelled) throw DownloadCancelledException()
                throw e
            } finally {
                connection.disconnect()
                activeConnection = null
            }

            if (!partial.renameTo(dest)) {
                partial.delete()
                throw IOException("Failed to finalize ${file.fileName}")
            }
            loadedSoFar += file.sizeBytes
            onProgress(DownloadProgress(file.fileName, loadedSoFar, totalBytes, true))
        }
    }
}
