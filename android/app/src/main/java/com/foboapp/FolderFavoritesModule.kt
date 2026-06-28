package com.foboapp

import android.content.Context
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class FolderFavoritesModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  private val preferences =
      reactContext.getSharedPreferences("fobo_folder_favorites", Context.MODE_PRIVATE)

  override fun getName(): String = "FolderFavorites"

  @ReactMethod
  fun getFavoritePaths(promise: Promise) {
    try {
      val result = Arguments.createArray()
      preferences.all.keys.sorted().forEach { path ->
        if (preferences.getBoolean(path, false)) {
          result.pushString(path)
        }
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("FAVORITES_READ_FAILED", error)
    }
  }

  @ReactMethod
  fun setFavorite(path: String, favorite: Boolean, promise: Promise) {
    try {
      val editor = preferences.edit()
      if (favorite) {
        editor.putBoolean(path, true)
      } else {
        editor.remove(path)
      }
      editor.apply()
      promise.resolve(favorite)
    } catch (error: Exception) {
      promise.reject("FAVORITES_SAVE_FAILED", error)
    }
  }
}
