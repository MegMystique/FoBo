package com.foboapp

import android.content.ContentUris
import android.database.Cursor
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import java.io.File

class AudioLibraryModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "AudioLibrary"

  private val audioExtensions = setOf("mp3", "m4a", "m4b", "aac", "wav", "ogg", "flac", "opus")

  @ReactMethod
  fun scanAudioFiles(promise: Promise) {
    Thread {
      try {
        Log.d("AudioLibrary", "Starting robust scan...")
        val result = Arguments.createArray()
        val foundKeys = mutableSetOf<String>()
        val scannablePaths = mutableSetOf<String>()

        // 1. Сканируем MediaStore
        scanMediaStore(result, foundKeys, scannablePaths)
        Log.d("AudioLibrary", "After MediaStore: ${foundKeys.size} files")

        // 2. Глубокое сканирование файловой системы
        scanFileSystem(result, foundKeys, scannablePaths)
        Log.d("AudioLibrary", "After FileSystem: ${foundKeys.size} files")

        // 3. Сообщаем системе о найденных нами файлах, чтобы она их проиндексировала для следующего раза
        if (scannablePaths.isNotEmpty()) {
            MediaScannerConnection.scanFile(reactContext, scannablePaths.toTypedArray(), null, null)
        }

        promise.resolve(result)
      } catch (error: Exception) {
        Log.e("AudioLibrary", "Scan failed", error)
        promise.reject("AUDIO_SCAN_FAILED", error)
      }
    }.start()
  }

  private fun scanMediaStore(
      result: WritableArray,
      foundKeys: MutableSet<String>,
      scannablePaths: MutableSet<String>
  ) {
    val resolver = reactContext.contentResolver
    val collection =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
          MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        }
    val projection = mutableListOf(
        MediaStore.Audio.Media._ID,
        MediaStore.Audio.Media.DISPLAY_NAME,
        MediaStore.Audio.Media.TITLE,
        MediaStore.Audio.Media.DURATION,
        MediaStore.Audio.Media.SIZE,
        MediaStore.Audio.Media.DATE_ADDED,
        MediaStore.Audio.Media.DATE_MODIFIED,
        MediaStore.Audio.Media.DATA
    )

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      projection.add(MediaStore.Audio.Media.RELATIVE_PATH)
      projection.add(MediaStore.Audio.Media.BUCKET_DISPLAY_NAME)
    }

    resolver.query(collection, projection.toTypedArray(), null, null, null)?.use { cursor ->
      while (cursor.moveToNext()) {
        try {
          val id = cursor.getLongValue(MediaStore.Audio.Media._ID)
          val contentUri = ContentUris.withAppendedId(collection, id).toString()
          if (foundKeys.contains(contentUri)) continue

          val path = cursor.getStringValue(MediaStore.Audio.Media.DATA)
          val fileName =
              cursor.getStringValue(MediaStore.Audio.Media.DISPLAY_NAME)
                  .ifBlank { path.fileName() }
                  .ifBlank { "Audio $id" }
          val title =
              cursor.getStringValue(MediaStore.Audio.Media.TITLE)
                  .ifBlank { fileName.substringBeforeLast('.', fileName) }

          val folderPath =
              path.parentPath()
                  .ifBlank { cursor.getStringValue(MediaStore.Audio.Media.RELATIVE_PATH).trimEnd('/') }
                  .ifBlank { "unknown" }
          val folderName =
              cursor.getStringValue(MediaStore.Audio.Media.BUCKET_DISPLAY_NAME)
                  .ifBlank { folderPath.folderName() }
                  .ifBlank { "Без папки" }

          val map = Arguments.createMap().apply {
            putString("id", contentUri)
            putString("uri", contentUri)
            putString("title", title)
            putString("fileName", fileName)
            putString("folderName", folderName)
            putString("folderPath", folderPath)
            putDouble("durationMs", cursor.getLongValue(MediaStore.Audio.Media.DURATION).toDouble())
            putDouble("size", cursor.getLongValue(MediaStore.Audio.Media.SIZE).toDouble())
            putDouble("dateAdded", cursor.getLongValue(MediaStore.Audio.Media.DATE_ADDED).toDouble())
            putDouble("dateModified", cursor.getLongValue(MediaStore.Audio.Media.DATE_MODIFIED).toDouble())
          }

          result.pushMap(map)
          foundKeys.add(contentUri)
          if (path.isNotBlank()) {
            foundKeys.add(path)
            scannablePaths.add(path)
          }
        } catch (e: Exception) {
          Log.e("AudioLibrary", "Error processing MediaStore row", e)
        }
      }
    }
  }

  private fun scanFileSystem(
      result: WritableArray,
      foundKeys: MutableSet<String>,
      scannablePaths: MutableSet<String>
  ) {
    val roots = mutableListOf<File>()

    // Внутренняя память
    roots.add(Environment.getExternalStorageDirectory())

    // Проверка всех смонтированных хранилищ (SD-карты)
    val storageDir = File("/storage")
    if (storageDir.exists() && storageDir.isDirectory) {
      storageDir.listFiles()?.forEach {
        if (it.isDirectory && it.canRead()) {
          val name = it.name
          if (name != "self" && name != "emulated" && name != "container") {
            roots.add(it)
          }
        }
      }
    }

    // Добавляем /storage/emulated/0 явно, если его нет
    val emulated = File("/storage/emulated/0")
    if (emulated.exists() && emulated.canRead()) roots.add(emulated)

    roots.distinctBy { it.absolutePath }.forEach { root ->
      recursiveScan(root, result, foundKeys, scannablePaths)
    }
  }

  private fun recursiveScan(
      file: File,
      result: WritableArray,
      foundKeys: MutableSet<String>,
      scannablePaths: MutableSet<String>
  ) {
    try {
      if (file.isDirectory) {
        if (file.name.startsWith(".") || file.name == "Android") return

        val children = file.listFiles()
        children?.forEach { recursiveScan(it, result, foundKeys, scannablePaths) }
      } else {
        val ext = file.extension.lowercase()
        if (audioExtensions.contains(ext)) {
          val canonicalPath = try { file.canonicalPath } catch (e: Exception) { file.absolutePath }
          if (!foundKeys.contains(canonicalPath)) {
            addFileToResult(file, 0, result, foundKeys, scannablePaths)
          }
        }
      }
    } catch (e: Exception) {
      // Игнорируем ошибки доступа к отдельным папкам
    }
  }

  private fun addFileToResult(
      file: File,
      duration: Long,
      result: WritableArray,
      foundKeys: MutableSet<String>,
      scannablePaths: MutableSet<String>
  ) {
    try {
      val path = try { file.canonicalPath } catch (e: Exception) { file.absolutePath }
      val folderFile = file.parentFile
      val folderPath = folderFile?.absolutePath ?: "unknown"
      val folderName = folderFile?.name ?: "Без папки"

      val map = Arguments.createMap().apply {
        // Используем путь как ID, чтобы исключить коллизии хэшей
        putString("id", path)
        putString("uri", Uri.fromFile(file).toString())
        putString("title", file.nameWithoutExtension)
        putString("fileName", file.name)
        putString("folderName", folderName)
        putString("folderPath", folderPath)
        putDouble("durationMs", duration.toDouble())
        putDouble("size", file.length().toDouble())
        putDouble("dateAdded", (file.lastModified() / 1000).toDouble())
        putDouble("dateModified", (file.lastModified() / 1000).toDouble())
      }
      result.pushMap(map)
      foundKeys.add(path)
      scannablePaths.add(path)
    } catch (e: Exception) {
      Log.e("AudioLibrary", "Error adding file to result: ${file.name}", e)
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

  private fun String.fileName(): String =
      if (isBlank()) "" else File(this).name

  private fun String.folderName(): String =
      if (isBlank()) "" else File(this).name.ifBlank { this }
}
