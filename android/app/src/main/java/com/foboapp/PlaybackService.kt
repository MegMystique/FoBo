package com.foboapp

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the app process alive while an audiobook is playing.  Without a foreground service Android
 * freezes the backgrounded process, so MediaPlayer completion callbacks (auto-advance, progress,
 * sleep timer) stop arriving.
 */
class PlaybackService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: lastTitle
    val isPlaying = intent?.getBooleanExtra(EXTRA_IS_PLAYING, true) ?: lastIsPlaying

    ServiceCompat.startForeground(
        this,
        NOTIFICATION_ID,
        buildNotification(this, title, isPlaying),
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        } else {
          0
        })
    running = true
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL_ID = "fobo_playback"
    private const val NOTIFICATION_ID = 1001
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_IS_PLAYING = "isPlaying"

    @Volatile private var running = false
    private var lastTitle: String = "FoBo"
    private var lastIsPlaying: Boolean = false

    fun show(context: Context, title: String, isPlaying: Boolean) {
      lastTitle = title
      lastIsPlaying = isPlaying

      if (running) {
        notify(context, title, isPlaying)
        return
      }

      try {
        val intent =
            Intent(context, PlaybackService::class.java)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_IS_PLAYING, isPlaying)
        ContextCompat.startForegroundService(context, intent)
      } catch (_: Exception) {
        // Starting a foreground service from the background can be refused on Android 12+.
        // Playback still works, it is just not protected from being frozen.
      }
    }

    fun stop(context: Context) {
      if (!running) return
      context.stopService(Intent(context, PlaybackService::class.java))
      running = false
    }

    @SuppressLint("MissingPermission")
    private fun notify(context: Context, title: String, isPlaying: Boolean) {
      try {
        NotificationManagerCompat.from(context)
            .notify(NOTIFICATION_ID, buildNotification(context, title, isPlaying))
      } catch (_: SecurityException) {
        // POST_NOTIFICATIONS was not granted; the service keeps running without updates.
      }
    }

    private fun buildNotification(context: Context, title: String, isPlaying: Boolean): Notification {
      ensureChannel(context)

      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val contentIntent =
          launchIntent?.let {
            PendingIntent.getActivity(
                context,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
          }

      return NotificationCompat.Builder(context, CHANNEL_ID)
          .setSmallIcon(
              if (isPlaying) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
          .setContentTitle(title)
          .setContentText(if (isPlaying) "Воспроизведение" else "Пауза")
          .setContentIntent(contentIntent)
          .setOngoing(isPlaying)
          .setOnlyAlertOnce(true)
          .setSilent(true)
          .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
          .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
          .build()
    }

    private fun ensureChannel(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) != null) return

      manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Воспроизведение", NotificationManager.IMPORTANCE_LOW))
    }
  }
}
