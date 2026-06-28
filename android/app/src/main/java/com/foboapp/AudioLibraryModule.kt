package com.foboapp

import android.content.ContentUris
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class AudioLibraryModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AudioLibrary"

  @ReactMethod
  fun scanAudioFiles(promise: Promise) {
    try {
      val resolver = reactContext.contentResolver
      val collection =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
          } else {
            MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
          }

      val projection =
          arrayOf(
              MediaStore.Audio.Media._ID,
              MediaStore.Audio.Media.DISPLAY_NAME,
              MediaStore.Audio.Media.TITLE,
              MediaStore.Audio.Media.DATA,
              MediaStore.Audio.Media.DURATION,
              MediaStore.Audio.Media.SIZE,
              MediaStore.Audio.Media.DATE_ADDED,
              MediaStore.Audio.Media.DATE_MODIFIED,
          )

      val result = Arguments.createArray()
      val selection = "${MediaStore.Audio.Media.IS_MUSIC} != 0"
      val sortOrder = "${MediaStore.Audio.Media.DATE_MODIFIED} DESC"

      resolver.query(collection, projection, selection, null, sortOrder)?.use { cursor ->
        while (cursor.moveToNext()) {
          val id = cursor.getLongValue(MediaStore.Audio.Media._ID)
          val contentUri: Uri = ContentUris.withAppendedId(collection, id)
          val fileName = cursor.getStringValue(MediaStore.Audio.Media.DISPLAY_NAME)
          val dataPath = cursor.getStringValue(MediaStore.Audio.Media.DATA)
          val folderPath = dataPath.parentPath()
          val folderName = folderPath.folderName()

          val map =
              Arguments.createMap().apply {
                putString("id", id.toString())
                putString("uri", contentUri.toString())
                putString("title", cursor.getStringValue(MediaStore.Audio.Media.TITLE))
                putString("fileName", fileName.ifBlank { "Audio $id" })
                putString("folderName", folderName.ifBlank { "Без папки" })
                putString("folderPath", folderPath.ifBlank { "unknown" })
                putDouble("durationMs", cursor.getLongValue(MediaStore.Audio.Media.DURATION).toDouble())
                putDouble("size", cursor.getLongValue(MediaStore.Audio.Media.SIZE).toDouble())
                putDouble("dateAdded", cursor.getLongValue(MediaStore.Audio.Media.DATE_ADDED).toDouble())
                putDouble(
                    "dateModified",
                    cursor.getLongValue(MediaStore.Audio.Media.DATE_MODIFIED).toDouble())
              }
          result.pushMap(map)
        }
      }

      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("AUDIO_SCAN_FAILED", error)
    }
  }

  private fun Cursor.getStringValue(column: String): String {
    val index = getColumnIndex(column)
    return if (index >= 0 && !isNull(index)) getString(index) else ""
  }

  private fun Cursor.getLongValue(column: String): Long {
    val index = getColumnIndex(column)
    return if (index >= 0 && !isNull(index)) getLong(index) else 0L
  }

  private fun String.parentPath(): String =
      if (isBlank()) "" else File(this).parentFile?.absolutePath.orEmpty()

  private fun String.folderName(): String =
      if (isBlank()) "" else File(this).name.ifBlank { this }
}
