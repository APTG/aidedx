package com.aidedx.fullapp.audio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/**
 * issue #136 goal 2 — the `AudioRecord` capture pattern proven on real hardware by
 * `DataGenActivity` (issue #130/#131, including the `stopRecordingInternal` stop -> join ->
 * release ordering fix for the reader-thread race), extracted into a standalone,
 * product-shaped class instead of copy-pasted inline into an Activity.
 */
class AudioRecorder {

    companion object {
        const val SAMPLE_RATE = 16000
    }

    private var audioRecord: AudioRecord? = null
    private var readerThread: Thread? = null
    private val recordedSamples = mutableListOf<Short>()
    @Volatile private var recording = false

    val isRecording: Boolean get() = recording

    fun start() {
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val bufSize = maxOf(minBuf, SAMPLE_RATE * 2)
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            bufSize,
        )
        recordedSamples.clear()
        audioRecord = record
        recording = true
        record.startRecording()

        readerThread = Thread {
            val buffer = ShortArray(bufSize / 2)
            while (recording) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    synchronized(recordedSamples) {
                        for (i in 0 until read) recordedSamples.add(buffer[i])
                    }
                }
            }
        }
        readerThread?.start()
    }

    /**
     * Stop -> join -> release, in that exact order (see file header): `stop()` unblocks the
     * reader thread's in-flight blocking `read()`, `join()` waits for it to have truly exited,
     * and only then is it safe to `release()` without risking an `IllegalStateException` from a
     * reader thread still mid-`read()` on the same object.
     */
    fun stop(): ShortArray {
        recording = false
        audioRecord?.stop()
        readerThread?.join()
        readerThread = null
        audioRecord?.release()
        audioRecord = null
        return synchronized(recordedSamples) { recordedSamples.toShortArray() }
    }
}
