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
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap

class AudioPlayerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private var player: MediaPlayer? = null
  private var queue: List<String> = emptyList()
  private var titles: List<String> = emptyList()
  private var currentIndex: Int = -1
  private var volume: Float = 1f
  private var prepared: Boolean = false
  // The current file already reached its end; its "completed" progress must not be overwritten
  // by currentPosition, which some devices report as 0 after completion.
  private var currentTrackCompleted: Boolean = false
  // Playback stopped at a chapter end because of the sleep timer: Play continues with the next file.
  private var stoppedAtTrackEnd: Boolean = false
  private var pausedByTransientFocusLoss: Boolean = false
  private var lastProgressSaveAt: Long = 0
  // MediaPlayer callbacks can arrive after release().  This token makes sure an
  // old chapter can never change the state of the chapter that replaced it.
  private var playerGeneration: Long = 0

  private var sleepDeadlineAt: Long = 0
  private var sleepFinishChapter: Boolean = false
  private var sleepWaitingForChapterEnd: Boolean = false

  // Everything (React methods, MediaPlayer and MediaSession callbacks, ticker) runs on the main
  // thread so player state is never touched concurrently.
  private val mainHandler = Handler(Looper.getMainLooper())
  private val audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null
  private var mediaSession: MediaSessionCompat? = null

  private val ticker =
      object : Runnable {
        override fun run() {
          tick()
          mainHandler.postDelayed(this, TICK_MS)
        }
      }

  private val afChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    mainHandler.post {
      when (focusChange) {
        AudioManager.AUDIOFOCUS_LOSS -> {
          pausedByTransientFocusLoss = false
          pauseInternal()
        }
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
          if (isPlaying()) {
            pausedByTransientFocusLoss = true
            pauseInternal(abandonFocus = false)
          }
        }
        AudioManager.AUDIOFOCUS_GAIN -> {
          if (pausedByTransientFocusLoss) {
            pausedByTransientFocusLoss = false
            resumeInternal()
          }
        }
      }
    }
  }

  override fun getName(): String = "AudioPlayer"

  init {
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
    mainHandler.post(ticker)
  }

  private fun onMain(block: () -> Unit) {
    mainHandler.post(block)
  }

  @ReactMethod
  fun loadQueue(uris: ReadableArray, names: ReadableArray, index: Int, promise: Promise) = onMain {
    saveCurrentProgress()
    queue = (0 until uris.size()).mapNotNull { uris.getString(it) }
    titles = (0 until names.size()).map { names.getString(it) ?: "" }
    if (queue.isEmpty()) {
      currentIndex = -1
      promise.resolve(stateMap())
      return@onMain
    }

    startTrack(index.coerceIn(queue.indices), promise)
  }

  @ReactMethod
  fun playIndex(index: Int, promise: Promise) = onMain {
    if (queue.isEmpty()) {
      promise.resolve(stateMap())
      return@onMain
    }
    saveCurrentProgress()
    startTrack(index.coerceIn(queue.indices), promise)
  }

  @ReactMethod
  fun pause(promise: Promise) = onMain {
    pausedByTransientFocusLoss = false
    pauseInternal()
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun resume(promise: Promise) = onMain {
    pausedByTransientFocusLoss = false
    if (!prepared && currentIndex in queue.indices) {
      startTrack(currentIndex, promise)
      return@onMain
    }
    checkSleepTimer(System.currentTimeMillis())
    if (continueAfterChapterEnd(promise)) return@onMain
    resumeInternal()
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun next(promise: Promise) = onMain {
    nextInternal()
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun previous(promise: Promise) = onMain {
    previousInternal()
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun seekTo(positionMs: Double, promise: Promise) = onMain {
    try {
      if (prepared) {
        player?.seekTo(positionMs.toInt().coerceAtLeast(0))
        currentTrackCompleted = false
        stoppedAtTrackEnd = false
        saveCurrentProgress(positionMs)
        updatePlaybackState()
      }
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_SEEK_FAILED", error)
    }
  }

  @ReactMethod
  fun setVolume(nextVolume: Double, promise: Promise) = onMain {
    try {
      volume = nextVolume.toFloat().coerceIn(0f, 1f)
      player?.setVolume(volume, volume)
      promise.resolve(stateMap())
    } catch (error: Exception) {
      promise.reject("AUDIO_VOLUME_FAILED", error)
    }
  }

  @ReactMethod
  fun setSleepTimer(durationMs: Double, finishChapter: Boolean, promise: Promise) = onMain {
    sleepDeadlineAt = System.currentTimeMillis() + durationMs.toLong().coerceAtLeast(0)
    sleepFinishChapter = finishChapter
    sleepWaitingForChapterEnd = false
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun cancelSleepTimer(promise: Promise) = onMain {
    clearSleepTimer()
    promise.resolve(stateMap())
  }

  @ReactMethod
  fun getState(promise: Promise) = onMain { promise.resolve(stateMap()) }

  private fun isPlaying(): Boolean = prepared && player?.isPlaying == true

  private fun pauseInternal(abandonFocus: Boolean = true) {
    try {
      if (isPlaying()) {
        player?.pause()
      }
      saveCurrentProgress()
      updatePlaybackState()
      if (abandonFocus) abandonAudioFocus()
    } catch (_: Exception) {}
  }

  /** Returns true when playback was (re)started. */
  private fun resumeInternal(): Boolean {
    if (!prepared) return false

    // A timer that ran out while paused must not stop playback right after Play.
    checkSleepTimer(System.currentTimeMillis())
    if (continueAfterChapterEnd(null)) return true

    return try {
      if (requestAudioFocus()) {
        stoppedAtTrackEnd = false
        currentTrackCompleted = false
        player?.start()
        updatePlaybackState()
        true
      } else {
        false
      }
    } catch (_: Exception) {
      false
    }
  }

  /** After the sleep timer stopped at a chapter end, Play continues with the next file. */
  private fun continueAfterChapterEnd(promise: Promise?): Boolean {
    if (!stoppedAtTrackEnd || currentIndex >= queue.lastIndex) return false
    startTrack(currentIndex + 1, promise)
    return true
  }

  private fun nextInternal() {
    val nextIndex = (currentIndex + 1).coerceAtMost(queue.lastIndex)
    if (nextIndex != currentIndex) {
      saveCurrentProgress()
      startTrack(nextIndex, null)
    }
  }

  private fun previousInternal() {
    val previousIndex = (currentIndex - 1).coerceAtLeast(0)
    if (previousIndex != currentIndex) {
      saveCurrentProgress()
      startTrack(previousIndex, null)
    }
  }

  private fun startTrack(index: Int, promise: Promise?) {
    var pending = promise
    fun settle() {
      pending?.resolve(stateMap())
      pending = null
    }

    try {
      if (queue.isEmpty() || index !in queue.indices) {
        settle()
        return
      }

      if (!requestAudioFocus()) {
        pending?.reject("AUDIO_FOCUS_DENIED", "Could not acquire audio focus")
        return
      }

      prepared = false
      currentTrackCompleted = false
      stoppedAtTrackEnd = false
      currentIndex = index
      lastProgressSaveAt = System.currentTimeMillis()
      val generation = ++playerGeneration
      player?.release()
      player = null
      updateMetadata()
      player =
          MediaPlayer().apply {
            setWakeMode(reactContext, PowerManager.PARTIAL_WAKE_LOCK)
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build())
            setDataSource(reactContext, Uri.parse(queue[index]))
            setVolume(volume, volume)
            setOnPreparedListener {
              if (!isCurrentPlayer(it, generation)) return@setOnPreparedListener
              prepared = true
              it.start()
              updatePlaybackState()
              settle()
            }
            setOnCompletionListener {
              if (!isCurrentPlayer(it, generation)) return@setOnCompletionListener
              onTrackCompleted()
            }
            setOnErrorListener { mediaPlayer, _, _ ->
              if (mediaPlayer != null && isCurrentPlayer(mediaPlayer, generation)) {
                skipBrokenTrackOrStop()
                settle()
              }
              true
            }
            prepareAsync()
          }
    } catch (error: Exception) {
      prepared = false
      updatePlaybackState()
      if (pending != null) {
        pending?.reject("AUDIO_PLAY_FAILED", error)
        pending = null
      } else {
        skipBrokenTrackOrStop()
      }
    }
  }

  private fun onTrackCompleted() {
    val uri = queue.getOrNull(currentIndex)
    val durationMs = player?.duration?.toDouble() ?: 0.0
    if (uri != null && durationMs > 0) {
      PlaybackProgressStore.save(reactContext, uri, durationMs, durationMs, completed = true)
    }
    currentTrackCompleted = true

    if (sleepWaitingForChapterEnd) {
      clearSleepTimer()
      stoppedAtTrackEnd = true
      updatePlaybackState()
      abandonAudioFocus()
      return
    }

    if (currentIndex < queue.lastIndex) {
      startTrack(currentIndex + 1, null)
    } else {
      updatePlaybackState()
      abandonAudioFocus()
      PlaybackService.stop(reactContext)
    }
  }

  private fun isCurrentPlayer(candidate: MediaPlayer, generation: Long): Boolean =
      player === candidate && playerGeneration == generation

  private fun skipBrokenTrackOrStop() {
    prepared = false
    if (currentIndex < queue.lastIndex) {
      startTrack(currentIndex + 1, null)
    } else {
      updatePlaybackState()
      abandonAudioFocus()
    }
  }

  private fun tick() {
    val now = System.currentTimeMillis()
    if (isPlaying() && now - lastProgressSaveAt >= PROGRESS_SAVE_INTERVAL_MS) {
      saveCurrentProgress()
    }
    checkSleepTimer(now)
  }

  private fun checkSleepTimer(now: Long) {
    if (sleepDeadlineAt == 0L || sleepWaitingForChapterEnd || now < sleepDeadlineAt) return

    if (!isPlaying()) {
      clearSleepTimer()
      return
    }

    if (sleepFinishChapter) {
      sleepWaitingForChapterEnd = true
    } else {
      clearSleepTimer()
      pausedByTransientFocusLoss = false
      pauseInternal()
    }
  }

  private fun clearSleepTimer() {
    sleepDeadlineAt = 0
    sleepFinishChapter = false
    sleepWaitingForChapterEnd = false
  }

  private fun saveCurrentProgress(positionOverrideMs: Double? = null) {
    if (!prepared || currentTrackCompleted) return
    val uri = queue.getOrNull(currentIndex) ?: return
    try {
      val durationMs = player?.duration?.toDouble() ?: return
      if (durationMs <= 0) return
      val positionMs = positionOverrideMs ?: player?.currentPosition?.toDouble() ?: return
      PlaybackProgressStore.save(reactContext, uri, positionMs, durationMs)
      lastProgressSaveAt = System.currentTimeMillis()
    } catch (_: Exception) {}
  }

  private fun requestAudioFocus(): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request =
          focusRequest
              ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                  .setAudioAttributes(
                      AudioAttributes.Builder()
                          .setUsage(AudioAttributes.USAGE_MEDIA)
                          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                          .build())
                  .setOnAudioFocusChangeListener(afChangeListener)
                  .build()
                  .also { focusRequest = it }
      audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
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

  private fun currentTitle(): String =
      titles.getOrNull(currentIndex)?.takeIf { it.isNotBlank() } ?: "FoBo"

  private fun updateMetadata() {
    mediaSession?.setMetadata(
        MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle())
            .build())
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

    val playing = isPlaying()
    val state = if (playing) {
      PlaybackStateCompat.STATE_PLAYING
    } else {
      PlaybackStateCompat.STATE_PAUSED
    }

    val position = try { player?.currentPosition?.toLong() ?: 0L } catch (_: Exception) { 0L }
    stateBuilder.setState(state, position, 1f)
    mediaSession?.setPlaybackState(stateBuilder.build())

    if (currentIndex in queue.indices) {
      PlaybackService.show(reactContext, currentTitle(), playing)
    }
  }

  private fun stateMap(): WritableMap =
      Arguments.createMap().apply {
        putString("currentUri", queue.getOrNull(currentIndex))
        putInt("index", currentIndex)
        putBoolean("isPlaying", isPlaying())
        putDouble("durationMs", if (prepared) player?.duration?.toDouble() ?: 0.0 else 0.0)
        putDouble("positionMs", if (prepared) player?.currentPosition?.toDouble() ?: 0.0 else 0.0)
        putDouble("volume", volume.toDouble())
        putDouble("sleepTimerDeadlineAt", sleepDeadlineAt.toDouble())
        putBoolean("sleepTimerFinishChapter", sleepFinishChapter)
        putBoolean("sleepTimerWaitingForChapterEnd", sleepWaitingForChapterEnd)
      }

  override fun invalidate() {
    mainHandler.removeCallbacks(ticker)
    mainHandler.post {
      saveCurrentProgress()
      mediaSession?.release()
      player?.release()
      player = null
      abandonAudioFocus()
      PlaybackService.stop(reactContext)
    }
    super.invalidate()
  }

  companion object {
    private const val TICK_MS = 1000L
    private const val PROGRESS_SAVE_INTERVAL_MS = 5000L
  }
}
