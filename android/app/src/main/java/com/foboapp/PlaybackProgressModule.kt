package com.foboapp

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import org.json.JSONObject

class PlaybackProgressModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val preferences =
      reactContext.getSharedPreferences("fobo_playback_progress", Context.MODE_PRIVATE)

  override fun getName(): String = "PlaybackProgress"

  @ReactMethod
  fun getAllProgress(promise: Promise) {
    try {
      val result = Arguments.createMap()
      preferences.all.forEach { (uri, value) ->
        val json = value as? String ?: return@forEach
        result.putMap(uri, jsonToMap(JSONObject(json)))
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("PROGRESS_READ_FAILED", error)
    }
  }

  @ReactMethod
  fun saveProgress(
      uri: String,
      positionMs: Double,
      durationMs: Double,
      completed: Boolean,
      promise: Promise
  ) {
    try {
      val json =
          JSONObject()
              .put("uri", uri)
              .put("positionMs", positionMs)
              .put("durationMs", durationMs)
              .put("completed", completed)
              .put("updatedAt", System.currentTimeMillis().toDouble())

      preferences.edit().putString(uri, json.toString()).apply()
      promise.resolve(jsonToMap(json))
    } catch (error: Exception) {
      promise.reject("PROGRESS_SAVE_FAILED", error)
    }
  }

  private fun jsonToMap(json: JSONObject): WritableMap =
      Arguments.createMap().apply {
        putString("uri", json.optString("uri"))
        putDouble("positionMs", json.optDouble("positionMs", 0.0))
        putDouble("durationMs", json.optDouble("durationMs", 0.0))
        putBoolean("completed", json.optBoolean("completed", false))
        putDouble("updatedAt", json.optDouble("updatedAt", 0.0))
      }
}
