package com.foboapp

import android.media.MediaPlayer
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class AudioPlayerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var player: MediaPlayer? = null
  private var queue: List<String> = emptyList()
  private var currentIndex: Int = -1
  private var volume: Float = 1f
  private var prepared: Boolean = false
  private var pauseAtEnd: Boolean = false

  override fun getName(): String = "AudioPlayer"

  @ReactMethod
  fun loadQueue(uris: com.facebook.react.bridge.ReadableArray, index: Int, promise: Promise) {
    queue = (0 until uris.size()).mapNotNull { uris.getString(it) }
    if (queue.isEmpty()) {
      currentIndex = -1
      promise.resolve(stateMap())
      return
    }

    playIndexInternal(index.coerceIn(queue.indices), promise)
  }

  @ReactMethod
  fun playIndex(index: Int, promise: Promise) {
    playIndexInternal(index.coerceIn(queue.indices), promise)
  }

  @ReactMethod
  fun pause(promise: Promise) {
    try {
      if (prepared && player?.isPlaying == true) {
        player?.pause()
      }
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_PAUSE_FAILED", error)
    }
  }

  @ReactMethod
  fun resume(promise: Promise) {
    try {
      if (prepared) {
        player?.start()
      } else if (currentIndex in queue.indices) {
        playIndexInternal(currentIndex, promise)
        return
      }
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_RESUME_FAILED", error)
    }
  }

  @ReactMethod
  fun next(promise: Promise) {
    val nextIndex = (currentIndex + 1).coerceAtMost(queue.lastIndex)
    playIndexInternal(nextIndex, promise)
  }

  @ReactMethod
  fun previous(promise: Promise) {
    val previousIndex = (currentIndex - 1).coerceAtLeast(0)
    playIndexInternal(previousIndex, promise)
  }

  @ReactMethod
  fun seekTo(positionMs: Double, promise: Promise) {
    try {
      if (prepared) {
        player?.seekTo(positionMs.toInt().coerceAtLeast(0))
      }
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_SEEK_FAILED", error)
    }
  }

  @ReactMethod
  fun setVolume(nextVolume: Double, promise: Promise) {
    try {
      volume = nextVolume.toFloat().coerceIn(0f, 1f)
      player?.setVolume(volume, volume)
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_VOLUME_FAILED", error)
    }
  }

  @ReactMethod
  fun setPauseAtEnd(enabled: Boolean, promise: Promise) {
    pauseAtEnd = enabled
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun getState(promise: Promise) {
    promise.resolve(stateMap())
  }

  private fun playIndexInternal(index: Int, promise: Promise) {
    try {
      if (queue.isEmpty() || index !in queue.indices) {
        promise.resolve(stateMap())
        return
      }

      prepared = false
      currentIndex = index
      player?.release()
      player =
          MediaPlayer().apply {
            setDataSource(reactContext, Uri.parse(queue[index]))
            setVolume(volume, volume)
            setOnPreparedListener {
              prepared = true
              it.start()
              promise.resolve(stateMap())
            }
            setOnCompletionListener {
              if (pauseAtEnd) {
                pauseAtEnd = false
                return@setOnCompletionListener
              }

              if (currentIndex < queue.lastIndex) {
                playIndexSilently(currentIndex + 1)
              }
            }
            prepareAsync()
          }
    } catch (error: Exception) {
      promise.reject("AUDIO_PLAY_FAILED", error)
    }
  }

  private fun playIndexSilently(index: Int) {
    try {
      if (queue.isEmpty() || index !in queue.indices) {
        return
      }

      prepared = false
      currentIndex = index
      player?.release()
      player =
          MediaPlayer().apply {
            setDataSource(reactContext, Uri.parse(queue[index]))
            setVolume(volume, volume)
            setOnPreparedListener {
              prepared = true
              it.start()
            }
            setOnCompletionListener {
              if (pauseAtEnd) {
                pauseAtEnd = false
                return@setOnCompletionListener
              }

              if (currentIndex < queue.lastIndex) {
                playIndexSilently(currentIndex + 1)
              }
            }
            prepareAsync()
          }
    } catch (_: Exception) {
      prepared = false
    }
  }

  private fun stateMap(): WritableMap =
      Arguments.createMap().apply {
        putString("currentUri", queue.getOrNull(currentIndex))
        putInt("index", currentIndex)
        putBoolean("isPlaying", prepared && player?.isPlaying == true)
        putDouble("durationMs", if (prepared) player?.duration?.toDouble() ?: 0.0 else 0.0)
        putDouble("positionMs", if (prepared) player?.currentPosition?.toDouble() ?: 0.0 else 0.0)
        putDouble("volume", volume.toDouble())
      }

}
