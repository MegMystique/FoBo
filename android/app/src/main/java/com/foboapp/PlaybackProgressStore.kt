package com.foboapp

import android.content.Context
import org.json.JSONObject

/**
 * Single place that writes listening progress.  The player saves progress natively so files are
 * marked as listened even while the JS thread is paused in the background.
 */
object PlaybackProgressStore {
  private const val PREFERENCES_NAME = "fobo_playback_progress"
  private const val COMPLETED_REMAINING_MS = 15_000.0
  private const val COMPLETED_RATIO = 0.97

  fun preferences(context: Context) =
      context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  fun isCompleted(positionMs: Double, durationMs: Double): Boolean {
    if (durationMs <= 0) return false
    return durationMs - positionMs <= COMPLETED_REMAINING_MS ||
        positionMs / durationMs >= COMPLETED_RATIO
  }

  fun save(
      context: Context,
      uri: String,
      positionMs: Double,
      durationMs: Double,
      completed: Boolean = isCompleted(positionMs, durationMs)
  ): JSONObject {
    val json =
        JSONObject()
            .put("uri", uri)
            .put("positionMs", if (completed) durationMs else positionMs)
            .put("durationMs", durationMs)
            .put("completed", completed)
            .put("updatedAt", System.currentTimeMillis().toDouble())

    preferences(context).edit().putString(uri, json.toString()).apply()
    return json
  }
}
