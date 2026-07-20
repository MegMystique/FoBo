package com.foboapp

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
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
  // MediaPlayer callbacks can arrive after release().  This token makes sure an
  // old chapter can never change the state of the chapter that replaced it.
  private var playerGeneration: Long = 0

  private val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var mediaSession: MediaSessionCompat? = null

  private val afChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS -> {
        pauseInternal()
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        pauseInternal()
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        resumeInternal()
      }
    }
  }

  override fun getName(): String = "AudioPlayer"

  init {
    val mainHandler = Handler(Looper.getMainLooper())
    // Инициализируем MediaSession с использованием Handler главного потока
    mediaSession = MediaSessionCompat(reactContext, "FoBoAudioPlayer").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() {
          mainHandler.post { resumeInternal() }
        }

        override fun onPause() {
          mainHandler.post { pauseInternal() }
        }

        override fun onSkipToNext() {
          mainHandler.post { nextInternal() }
        }

        override fun onSkipToPrevious() {
          mainHandler.post { previousInternal() }
        }
      }, mainHandler)
      isActive = true
    }
  }

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
    pauseInternal()
    promise.resolve(stateMap())
  }

  private fun pauseInternal() {
    try {
      if (prepared && player?.isPlaying == true) {
        player?.pause()
      }
      updatePlaybackState()
      abandonAudioFocus()
    } catch (_: Exception) {}
  }

  @ReactMethod
  fun resume(promise: Promise) {
    if (resumeInternal()) {
      promise.resolve(stateMap())
    } else if (currentIndex in queue.indices) {
      playIndexInternal(currentIndex, promise)
    } else {
      promise.resolve(stateMap())
    }
  }

  private fun resumeInternal(): Boolean {
    return try {
      if (prepared) {
        if (requestAudioFocus()) {
          player?.start()
          updatePlaybackState()
          true
        } else {
          false
        }
      } else {
        false
      }
    } catch (error: Exception) {
      false
    }
  }

  @ReactMethod
  fun next(promise: Promise) {
    nextInternal()
    promise.resolve(stateMap())
  }

  private fun nextInternal() {
    val nextIndex = (currentIndex + 1).coerceAtMost(queue.lastIndex)
    if (nextIndex != currentIndex) {
      playIndexSilently(nextIndex)
    }
  }

  @ReactMethod
  fun previous(promise: Promise) {
    previousInternal()
    promise.resolve(stateMap())
  }

  private fun previousInternal() {
    val previousIndex = (currentIndex - 1).coerceAtLeast(0)
    if (previousIndex != currentIndex) {
      playIndexSilently(previousIndex)
    }
  }

  @ReactMethod
  fun seekTo(positionMs: Double, promise: Promise) {
    try {
      if (prepared) {
        player?.seekTo(positionMs.toInt().coerceAtLeast(0))
        updatePlaybackState()
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

      if (!requestAudioFocus()) {
        promise.reject("AUDIO_FOCUS_DENIED", "Could not acquire audio focus")
        return
      }

      prepared = false
      currentIndex = index
      val generation = ++playerGeneration
      player?.release()
      player =
          MediaPlayer().apply {
            setDataSource(reactContext, Uri.parse(queue[index]))
            setVolume(volume, volume)
            setOnPreparedListener {
              if (!isCurrentPlayer(it, generation)) return@setOnPreparedListener
              prepared = true
              it.start()
              updatePlaybackState()
              promise.resolve(stateMap())
            }
            setOnCompletionListener {
              if (!isCurrentPlayer(it, generation)) return@setOnCompletionListener
              if (pauseAtEnd) {
                pauseAtEnd = false
                updatePlaybackState()
                return@setOnCompletionListener
              }

              if (currentIndex < queue.lastIndex) {
                playIndexSilently(currentIndex + 1)
              } else {
                updatePlaybackState()
                abandonAudioFocus()
              }
            }
            setOnErrorListener { mediaPlayer, _, _ ->
              if (mediaPlayer != null && isCurrentPlayer(mediaPlayer, generation)) {
                skipBrokenTrackOrStop()
              }
              true
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

      if (!requestAudioFocus()) {
        return
      }

      prepared = false
      currentIndex = index
      val generation = ++playerGeneration
      player?.release()
      player =
          MediaPlayer().apply {
            setDataSource(reactContext, Uri.parse(queue[index]))
            setVolume(volume, volume)
            setOnPreparedListener {
              if (!isCurrentPlayer(it, generation)) return@setOnPreparedListener
              prepared = true
              it.start()
              updatePlaybackState()
            }
            setOnCompletionListener {
              if (!isCurrentPlayer(it, generation)) return@setOnCompletionListener
              if (pauseAtEnd) {
                pauseAtEnd = false
                updatePlaybackState()
                return@setOnCompletionListener
              }

              if (currentIndex < queue.lastIndex) {
                playIndexSilently(currentIndex + 1)
              } else {
                updatePlaybackState()
                abandonAudioFocus()
              }
            }
            setOnErrorListener { mediaPlayer, _, _ ->
              if (mediaPlayer != null && isCurrentPlayer(mediaPlayer, generation)) {
                skipBrokenTrackOrStop()
              }
              true
            }
            prepareAsync()
          }
    } catch (_: Exception) {
      prepared = false
      updatePlaybackState()
    }
  }

  private fun isCurrentPlayer(candidate: MediaPlayer, generation: Long): Boolean =
      player === candidate && playerGeneration == generation

  private fun skipBrokenTrackOrStop() {
    prepared = false
    if (currentIndex < queue.lastIndex) {
      playIndexSilently(currentIndex + 1)
    } else {
      updatePlaybackState()
      abandonAudioFocus()
    }
  }

  private fun requestAudioFocus(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val playbackAttributes = AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
          .build()
      focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
          .setAudioAttributes(playbackAttributes)
          .setAcceptsDelayedFocusGain(true)
          .setOnAudioFocusChangeListener(afChangeListener)
          .build()
      audioManager.requestAudioFocus(focusRequest!!) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(afChangeListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
  }

  private fun abandonAudioFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(afChangeListener)
    }
  }

  private fun updatePlaybackState() {
    val stateBuilder = PlaybackStateCompat.Builder()
        .setActions(
            PlaybackStateCompat.ACTION_PLAY or
            PlaybackStateCompat.ACTION_PAUSE or
            PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
            PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
            PlaybackStateCompat.ACTION_PLAY_PAUSE
        )

    val state = if (prepared && player?.isPlaying == true) {
      PlaybackStateCompat.STATE_PLAYING
    } else {
      PlaybackStateCompat.STATE_PAUSED
    }

    stateBuilder.setState(state, player?.currentPosition?.toLong() ?: 0L, 1f)
    mediaSession?.setPlaybackState(stateBuilder.build())
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

  override fun onCatalystInstanceDestroy() {
    super.onCatalystInstanceDestroy()
    mediaSession?.release()
    player?.release()
    abandonAudioFocus()
  }
}
