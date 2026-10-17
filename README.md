# FoBo

FoBo is an Android audiobook player for local files. It finds audio on the device, groups it by folder (one folder is one book) and plays the files in order, remembering where you stopped.

## Features

- **Library**: scans audio files on the device, groups them by folder, sorts by name or modification date; favorite folders are pinned to the top.
- **Queue playback**: files in a folder play one after another in natural order (`2.mp3` comes before `10.mp3`); broken files are skipped.
- **Progress**: the position is saved every few seconds, on pause and when switching files; finished files are marked with ✓, and reopening a file resumes where you left off.
- **Background playback**: a foreground service with a notification and a wake lock keeps playback, auto-advance to the next file and progress saving working with the screen off.
- **Sleep timer**: 15/30/45/60 minutes, with a "Finish chapter" option that plays the current file to the end and stops; pressing Play afterwards continues with the next chapter.
- **Controls**: a mini player on the list screens, lock screen and headset buttons (MediaSession), pause during a phone call and automatic resume after it.

## Project structure

- `App.tsx`: the whole UI (library, folder, player, mini player, sleep timer).
- `android/app/src/main/java/com/foboapp/`:
  - `AudioLibraryModule.kt`: scans audio via MediaStore;
  - `AudioPlayerModule.kt`: `MediaPlayer`-based player: queue, audio focus, MediaSession, sleep timer, progress saving;
  - `PlaybackService.kt`: a foreground service that keeps the system from freezing the process during playback;
  - `PlaybackProgressStore.kt` / `PlaybackProgressModule.kt`: progress storage in SharedPreferences;
  - `FolderFavoritesModule.kt`: favorite folders.

Playback, progress and sleep timer logic lives on the native side, because React Native JS timers stop when the app goes to the background.

## Building the APK

From the `android` folder, build the APK:

```sh
./gradlew assembleRelease   # on Windows: gradlew.bat assembleRelease
```

The output is `android/app/build/outputs/apk/release/app-release.apk`. The release build is signed with the debug key, so it installs over a debug build. Copy the file to the phone and install it, or install over USB:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

---

This is a new [**React Native**](https://reactnative.dev) project, bootstrapped using [`@react-native-community/cli`](https://github.com/react-native-community/cli).

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
