import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  BackHandler,
  FlatList,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

type AudioFile = {
  id: string;
  uri: string;
  title: string;
  fileName: string;
  folderName: string;
  folderPath: string;
  durationMs: number;
  size: number;
  dateAdded?: number;
  dateModified?: number;
};

type AudioFolder = {
  name: string;
  path: string;
  files: AudioFile[];
  updatedAt: number;
};

type PlayerState = {
  currentUri?: string;
  index: number;
  isPlaying: boolean;
  durationMs: number;
  positionMs: number;
  volume: number;
};

type PlaybackProgress = {
  uri: string;
  positionMs: number;
  durationMs: number;
  completed: boolean;
  updatedAt: number;
};

type ProgressByUri = Record<string, PlaybackProgress>;
type FavoriteFolders = Record<string, boolean>;

type SleepTimer = {
  deadlineAt: number;
  finishChapter: boolean;
  waitingForChapterEnd: boolean;
};

type Screen =
  | {name: 'library'}
  | {name: 'folder'; folder: AudioFolder}
  | {name: 'player'; folder: AudioFolder; index: number};

type FolderSort = 'name' | 'date';

const {AudioLibrary, AudioPlayer, PlaybackProgress, FolderFavorites} = NativeModules as {
  AudioLibrary?: {
    scanAudioFiles: () => Promise<AudioFile[]>;
  };
  AudioPlayer?: {
    loadQueue: (uris: string[], index: number) => Promise<PlayerState>;
    playIndex: (index: number) => Promise<PlayerState>;
    pause: () => Promise<PlayerState>;
    resume: () => Promise<PlayerState>;
    next: () => Promise<PlayerState>;
    previous: () => Promise<PlayerState>;
    seekTo: (positionMs: number) => Promise<PlayerState>;
    setVolume: (volume: number) => Promise<PlayerState>;
    setPauseAtEnd?: (enabled: boolean) => Promise<PlayerState>;
    getState: () => Promise<PlayerState>;
  };
  PlaybackProgress?: {
    getAllProgress: () => Promise<ProgressByUri>;
    saveProgress: (
      uri: string,
      positionMs: number,
      durationMs: number,
      completed: boolean,
    ) => Promise<PlaybackProgress>;
  };
  FolderFavorites?: {
    getFavoritePaths: () => Promise<string[]>;
    setFavorite: (path: string, favorite: boolean) => Promise<boolean>;
  };
};

function App() {
  const [screen, setScreen] = useState<Screen>({name: 'library'});
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [folderSort, setFolderSort] = useState<FolderSort>('name');
  const [isScanning, setIsScanning] = useState(false);
  const [isSleepTimerOpen, setIsSleepTimerOpen] = useState(false);
  const [sleepTimer, setSleepTimer] = useState<SleepTimer | undefined>();
  const [progressByUri, setProgressByUri] = useState<ProgressByUri>({});
  const [favoriteFolders, setFavoriteFolders] = useState<FavoriteFolders>({});
  const [playerState, setPlayerState] = useState<PlayerState>({
    index: -1,
    isPlaying: false,
    durationMs: 0,
    positionMs: 0,
    volume: 1,
  });
  const lastSavedProgressRef = useRef<{uri?: string; positionMs: number; savedAt: number}>({
    positionMs: 0,
    savedAt: 0,
  });

  const folders = useMemo(
    () => buildFolders(files, folderSort, favoriteFolders),
    [favoriteFolders, files, folderSort],
  );
  const currentPlayback = useMemo(() => {
    if (!playerState.currentUri) {
      return undefined;
    }

    for (const folder of folders) {
      const index = folder.files.findIndex(file => file.uri === playerState.currentUri);
      if (index >= 0) {
        return {folder, file: folder.files[index], index};
      }
    }

    return undefined;
  }, [folders, playerState.currentUri]);

  const scanLibrary = useCallback(async () => {
    if (Platform.OS !== 'android') {
      Alert.alert('Android only', 'Первая итерация сканера сделана для Android.');
      return;
    }

    if (!AudioLibrary) {
      Alert.alert('Сканер недоступен', 'Нативный модуль AudioLibrary не подключен.');
      return;
    }

    const granted = await requestAudioPermission();
    if (!granted) {
      Alert.alert('Нет доступа', 'Нужен доступ к аудиофайлам на устройстве.');
      return;
    }

    setIsScanning(true);
    try {
      const result = await AudioLibrary.scanAudioFiles();
      setFiles(result);
    } catch (error) {
      Alert.alert('Ошибка сканирования', String(error));
    } finally {
      setIsScanning(false);
    }
  }, []);

  useEffect(() => {
    scanLibrary();
  }, [scanLibrary]);

  const refreshProgress = useCallback(async () => {
    if (!PlaybackProgress) {
      return;
    }

    const result = await PlaybackProgress.getAllProgress();
    setProgressByUri(result);
  }, []);

  useEffect(() => {
    refreshProgress();
  }, [refreshProgress]);

  const refreshFavoriteFolders = useCallback(async () => {
    if (!FolderFavorites) {
      return;
    }

    const paths = await FolderFavorites.getFavoritePaths();
    setFavoriteFolders(
      paths.reduce<FavoriteFolders>((acc, path) => {
        acc[path] = true;
        return acc;
      }, {}),
    );
  }, []);

  useEffect(() => {
    refreshFavoriteFolders();
  }, [refreshFavoriteFolders]);

  const toggleFavoriteFolder = useCallback(async (folder: AudioFolder) => {
    const nextFavorite = !favoriteFolders[folder.path];

    setFavoriteFolders(current => ({
      ...current,
      [folder.path]: nextFavorite,
    }));

    try {
      await FolderFavorites?.setFavorite(folder.path, nextFavorite);
    } catch (error) {
      setFavoriteFolders(current => ({
        ...current,
        [folder.path]: !nextFavorite,
      }));
      Alert.alert('Ошибка избранного', String(error));
    }
  }, [favoriteFolders]);

  const savePlaybackProgress = useCallback(
    async (state: PlayerState, force = false) => {
      if (!PlaybackProgress || !state.currentUri || state.durationMs <= 0) {
        return;
      }

      const now = Date.now();
      const lastSaved = lastSavedProgressRef.current;
      const sameFile = lastSaved.uri === state.currentUri;
      const positionDelta = Math.abs(state.positionMs - lastSaved.positionMs);

      if (!force && sameFile && positionDelta < 5000 && now - lastSaved.savedAt < 5000) {
        return;
      }

      const completed = isCompleted(state.positionMs, state.durationMs);
      const saved = await PlaybackProgress.saveProgress(
        state.currentUri,
        completed ? state.durationMs : state.positionMs,
        state.durationMs,
        completed,
      );

      lastSavedProgressRef.current = {
        uri: state.currentUri,
        positionMs: state.positionMs,
        savedAt: now,
      };
      setProgressByUri(current => ({...current, [state.currentUri!]: saved}));
    },
    [],
  );

  const setNativePauseAtEnd = useCallback(async (enabled: boolean) => {
    if (!AudioPlayer?.setPauseAtEnd) {
      return;
    }

    await AudioPlayer.setPauseAtEnd(enabled);
  }, []);

  const pauseForSleepTimer = useCallback(
    async (state: PlayerState) => {
      if (!AudioPlayer) {
        return;
      }

      const pausedState = await AudioPlayer.pause();
      setPlayerState(pausedState);
      await savePlaybackProgress({...state, ...pausedState}, true);
      setSleepTimer(undefined);
    },
    [savePlaybackProgress],
  );

  useEffect(() => {
    if (!sleepTimer || !AudioPlayer) {
      return;
    }

    const timer = setInterval(async () => {
      const now = Date.now();

      if (now < sleepTimer.deadlineAt) {
        return;
      }

      if (!sleepTimer.finishChapter) {
        await pauseForSleepTimer(playerState);
        return;
      }

      if (!sleepTimer.waitingForChapterEnd) {
        await setNativePauseAtEnd(true);
        setSleepTimer(current =>
          current ? {...current, waitingForChapterEnd: true} : current,
        );
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [pauseForSleepTimer, playerState, setNativePauseAtEnd, sleepTimer]);

  useEffect(() => {
    if (!AudioPlayer) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const state = await AudioPlayer.getState();
        setPlayerState(state);
        savePlaybackProgress(state);

        if (
          sleepTimer?.waitingForChapterEnd &&
          !state.isPlaying &&
          isAtTrackEnd(state.positionMs, state.durationMs)
        ) {
          await savePlaybackProgress(state, true);
          setSleepTimer(undefined);
        }
      } catch {
        // Player can be empty before the first file is opened.
      }
    }, 700);

    return () => clearInterval(timer);
  }, [savePlaybackProgress, sleepTimer?.waitingForChapterEnd]);

  const startSleepTimer = useCallback(async (minutes: number, finishChapter: boolean) => {
    await setNativePauseAtEnd(false);

    setSleepTimer({
      deadlineAt: Date.now() + minutes * 60 * 1000,
      finishChapter,
      waitingForChapterEnd: false,
    });
    setIsSleepTimerOpen(false);
  }, [setNativePauseAtEnd]);

  const cancelSleepTimer = useCallback(async () => {
    await setNativePauseAtEnd(false);

    setSleepTimer(undefined);
    setIsSleepTimerOpen(false);
  }, [setNativePauseAtEnd]);

  const openPlayer = async (folder: AudioFolder, index: number) => {
    if (!AudioPlayer) {
      Alert.alert('Плеер недоступен', 'Нативный модуль AudioPlayer не подключен.');
      return;
    }

    const state = await AudioPlayer.loadQueue(
      folder.files.map(file => file.uri),
      index,
    );
    const fileProgress = progressByUri[folder.files[index]?.uri];
    const shouldResume =
      fileProgress &&
      !fileProgress.completed &&
      fileProgress.positionMs > 3000 &&
      fileProgress.positionMs < state.durationMs - 3000;
    const nextState = shouldResume
      ? await AudioPlayer.seekTo(fileProgress.positionMs)
      : state;

    setPlayerState(nextState);
    setScreen({name: 'player', folder, index});
  };

  const navigateBack = useCallback(async () => {
    if (screen.name === 'player') {
      await savePlaybackProgress(playerState, true);
      setScreen({name: 'folder', folder: screen.folder});
      return true;
    }

    if (screen.name === 'folder') {
      setScreen({name: 'library'});
      return true;
    }

    return false;
  }, [playerState, savePlaybackProgress, screen]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (screen.name === 'library') {
        return false;
      }

      navigateBack().catch(() => undefined);
      return true;
    });

    return () => subscription.remove();
  }, [navigateBack, screen.name]);

  const openCurrentPlayer = useCallback(() => {
    if (!currentPlayback) {
      return;
    }

    setScreen({
      name: 'player',
      folder: currentPlayback.folder,
      index: currentPlayback.index,
    });
  }, [currentPlayback]);

  const toggleMiniPlayback = useCallback(async () => {
    if (!AudioPlayer) {
      return;
    }

    if (playerState.isPlaying) {
      const state = await AudioPlayer.pause();
      setPlayerState(state);
      await savePlaybackProgress(state, true);
      return;
    }

    const state = await AudioPlayer.resume();
    setPlayerState(state);
  }, [playerState.isPlaying, savePlaybackProgress]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <StatusBar barStyle="dark-content" backgroundColor="#fff8ec" />
        {screen.name === 'library' ? (
          <LibraryScreen
            folders={folders}
            sort={folderSort}
            isScanning={isScanning}
            favoriteFolders={favoriteFolders}
            onSortChange={setFolderSort}
            onScan={scanLibrary}
            onOpenFolder={folder => setScreen({name: 'folder', folder})}
            onToggleFavorite={toggleFavoriteFolder}
          />
        ) : null}

        {screen.name === 'folder' ? (
          <FolderScreen
            folder={screen.folder}
            progressByUri={progressByUri}
            currentUri={playerState.currentUri}
            onBack={() => {
              navigateBack().catch(() => undefined);
            }}
            onPlay={index => openPlayer(screen.folder, index)}
          />
        ) : null}

        {screen.name === 'player' ? (
          <PlayerScreen
            folder={screen.folder}
            playerState={playerState}
            progress={playerState.currentUri ? progressByUri[playerState.currentUri] : undefined}
            sleepTimer={sleepTimer}
            onBack={() => {
              navigateBack().catch(() => undefined);
            }}
            onPause={async () => {
              const state = await AudioPlayer!.pause();
              setPlayerState(state);
              await savePlaybackProgress(state, true);
            }}
            onResume={async () => setPlayerState(await AudioPlayer!.resume())}
            onNext={async () => {
              await savePlaybackProgress(playerState, true);
              setPlayerState(await AudioPlayer!.next());
            }}
            onPrevious={async () => {
              await savePlaybackProgress(playerState, true);
              setPlayerState(await AudioPlayer!.previous());
            }}
            onSeek={async position => {
              const state = await AudioPlayer!.seekTo(position);
              setPlayerState(state);
              await savePlaybackProgress(state, true);
            }}
            onVolume={async volume => setPlayerState(await AudioPlayer!.setVolume(volume))}
            onOpenSleepTimer={() => setIsSleepTimerOpen(true)}
            onCancelSleepTimer={cancelSleepTimer}
          />
        ) : null}

        {screen.name !== 'player' && currentPlayback ? (
          <MiniPlayer
            file={currentPlayback.file}
            playerState={playerState}
            onOpen={openCurrentPlayer}
            onToggle={toggleMiniPlayback}
          />
        ) : null}

        <SleepTimerModal
          visible={isSleepTimerOpen}
          onClose={() => setIsSleepTimerOpen(false)}
          onStart={startSleepTimer}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function LibraryScreen({
  folders,
  sort,
  isScanning,
  favoriteFolders,
  onSortChange,
  onScan,
  onOpenFolder,
  onToggleFavorite,
}: {
  folders: AudioFolder[];
  sort: FolderSort;
  isScanning: boolean;
  favoriteFolders: FavoriteFolders;
  onSortChange: (sort: FolderSort) => void;
  onScan: () => void;
  onOpenFolder: (folder: AudioFolder) => void;
  onToggleFavorite: (folder: AudioFolder) => void;
}) {
  return (
    <View style={styles.screen}>
      <Header title="FoBo" rightLabel={isScanning ? '...' : 'Scan'} onRightPress={onScan} />
      <View style={styles.toolbar}>
        <Text style={styles.muted}>Сортировка</Text>
        <SegmentedControl
          value={sort}
          options={[
            {value: 'name', label: 'Название'},
            {value: 'date', label: 'Дата'},
          ]}
          onChange={onSortChange}
        />
      </View>

      <FlatList
        data={folders}
        keyExtractor={item => item.path}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {isScanning ? 'Ищу аудиофайлы...' : 'Аудиопапки пока не найдены.'}
          </Text>
        }
        renderItem={({item}) => (
          <Pressable style={styles.row} onPress={() => onOpenFolder(item)}>
            <View style={styles.folderIcon}>
              <Text style={styles.folderIconText}>♪</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta}>
                {item.files.length} файлов · изменено {formatDate(item.updatedAt)}
              </Text>
            </View>
            <Pressable
              style={styles.favoriteButton}
              onPress={() => onToggleFavorite(item)}>
              <Text
                style={[
                  styles.favoriteButtonText,
                  favoriteFolders[item.path] && styles.favoriteButtonTextActive,
                ]}>
                {favoriteFolders[item.path] ? '★' : '☆'}
              </Text>
            </Pressable>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function FolderScreen({
  folder,
  progressByUri,
  currentUri,
  onBack,
  onPlay,
}: {
  folder: AudioFolder;
  progressByUri: ProgressByUri;
  currentUri?: string;
  onBack: () => void;
  onPlay: (index: number) => void;
}) {
  return (
    <View style={styles.screen}>
      <Header title={folder.name} leftLabel="‹" onLeftPress={onBack} />
      <FlatList
        data={folder.files}
        keyExtractor={item => item.uri}
        contentContainerStyle={styles.listContent}
        renderItem={({item, index}) => {
          const progress = progressByUri[item.uri];
          const completed = progress?.completed;
          const hasProgress = progress && progress.positionMs > 3000 && !completed;
          const isCurrent = item.uri === currentUri;

          return (
            <Pressable
              style={[styles.row, isCurrent && styles.currentRow]}
              onPress={() => onPlay(index)}>
              <View
                style={[
                  styles.playBadge,
                  completed && styles.completedBadge,
                  isCurrent && styles.currentBadge,
                ]}>
                <Text style={styles.playBadgeText}>
                  {isCurrent ? 'Ⅱ' : completed ? '✓' : '▶'}
                </Text>
              </View>
              <View style={styles.rowBody}>
                <Text
                  style={[
                    styles.rowTitle,
                    completed && styles.completedTitle,
                    isCurrent && styles.currentTitle,
                  ]}
                  numberOfLines={1}>
                  {item.fileName}
                </Text>
                <Text style={styles.rowMeta}>
                  {formatDuration(item.durationMs)}
                  {isCurrent
                    ? ' · сейчас играет'
                    : hasProgress
                    ? ` · ${formatDuration(progress.positionMs)}`
                    : completed
                      ? ' · прослушано'
                      : ''}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

function PlayerScreen({
  folder,
  playerState,
  progress,
  sleepTimer,
  onBack,
  onPause,
  onResume,
  onNext,
  onPrevious,
  onSeek,
  onVolume,
  onOpenSleepTimer,
  onCancelSleepTimer,
}: {
  folder: AudioFolder;
  playerState: PlayerState;
  progress?: PlaybackProgress;
  sleepTimer?: SleepTimer;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
  onVolume: (volume: number) => void;
  onOpenSleepTimer: () => void;
  onCancelSleepTimer: () => void;
}) {
  const currentFile = folder.files[playerState.index] ?? folder.files[0];
  const nextFile = folder.files[playerState.index + 1];
  const sleepTimerLabel = sleepTimer
    ? sleepTimer.waitingForChapterEnd
      ? 'Доигрывает главу'
      : `Осталось ${formatCountdown(sleepTimer.deadlineAt - Date.now())}`
    : 'Не установлен';

  return (
    <View style={styles.screen}>
      <Header title="Сейчас играет" leftLabel="‹" onLeftPress={onBack} rightLabel="⏱" />
      <View style={styles.playerPanel}>
        <Text style={styles.bookTitle}>{folder.name}</Text>
        <Text style={styles.trackTitle} numberOfLines={2}>
          {currentFile?.fileName ?? 'Файл не выбран'}
        </Text>

        <View style={styles.timeRow}>
          <Text style={styles.time}>{formatDuration(playerState.positionMs)}</Text>
          <Text style={styles.time}>{formatDuration(playerState.durationMs)}</Text>
        </View>
        <Scrubber
          value={playerState.positionMs}
          max={playerState.durationMs}
          onChange={onSeek}
        />

        <View style={styles.controls}>
          <RoundButton label="⏮" onPress={onPrevious} />
          <RoundButton
            label={playerState.isPlaying ? 'Ⅱ' : '▶'}
            primary
            onPress={playerState.isPlaying ? onPause : onResume}
          />
          <RoundButton label="⏭" onPress={onNext} />
        </View>

        <Text style={styles.sectionLabel}>Громкость</Text>
        <View style={styles.volumeRow}>
          <Text style={styles.volumeIcon}>−</Text>
          <Scrubber
            value={playerState.volume}
            max={1}
            onChange={onVolume}
            compact
          />
          <Text style={styles.volumeIcon}>+</Text>
        </View>

        <Pressable style={styles.sleepTimer} onPress={onOpenSleepTimer}>
          <Text style={styles.sleepTimerTitle}>⏱ Таймер сна</Text>
          <Text style={styles.sleepTimerMeta}>{sleepTimerLabel}</Text>
        </Pressable>
        {sleepTimer ? (
          <Pressable style={styles.cancelSleepTimer} onPress={onCancelSleepTimer}>
            <Text style={styles.cancelSleepTimerText}>Отменить таймер</Text>
          </Pressable>
        ) : null}

        <Text style={styles.nextText} numberOfLines={1}>
          Следующий: {nextFile?.fileName ?? 'конец папки'}
        </Text>
        {progress?.completed ? (
          <Text style={styles.progressHint}>Прослушано</Text>
        ) : null}
      </View>
    </View>
  );
}

function MiniPlayer({
  file,
  playerState,
  onOpen,
  onToggle,
}: {
  file: AudioFile;
  playerState: PlayerState;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const ratio =
    playerState.durationMs > 0
      ? Math.min(1, Math.max(0, playerState.positionMs / playerState.durationMs))
      : 0;

  return (
    <View style={styles.miniPlayer}>
      <View style={styles.miniProgressTrack}>
        <View style={[styles.miniProgressFill, {width: `${ratio * 100}%`}]} />
      </View>
      <View style={styles.miniPlayerRow}>
        <Pressable style={styles.miniPlayButton} onPress={onToggle}>
          <Text style={styles.miniPlayButtonText}>
            {playerState.isPlaying ? 'Ⅱ' : '▶'}
          </Text>
        </Pressable>
        <Pressable style={styles.miniPlayerBody} onPress={onOpen}>
          <Text style={styles.miniPlayerTitle} numberOfLines={1}>
            {file.fileName}
          </Text>
          <Text style={styles.miniPlayerMeta}>
            {formatDuration(playerState.positionMs)} / {formatDuration(playerState.durationMs)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function SleepTimerModal({
  visible,
  onClose,
  onStart,
}: {
  visible: boolean;
  onClose: () => void;
  onStart: (minutes: number, finishChapter: boolean) => Promise<void>;
}) {
  const [finishChapter, setFinishChapter] = useState(false);
  const options = [15, 30, 45, 60];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <Pressable style={styles.modalScrim} onPress={onClose} />
        <View style={styles.sleepModal}>
          <View style={styles.sleepModalHeader}>
            <Text style={styles.sleepModalTitle}>Таймер сна</Text>
            <Pressable style={styles.modalCloseButton} onPress={onClose}>
              <Text style={styles.modalCloseText}>×</Text>
            </Pressable>
          </View>

          <View style={styles.timerOptions}>
            {options.map(minutes => (
              <Pressable
                key={minutes}
                style={styles.timerOption}
                onPress={() => {
                  onStart(minutes, finishChapter).catch(error => {
                    Alert.alert('Ошибка таймера', String(error));
                  });
                }}>
                <Text style={styles.timerOptionText}>{minutes} мин</Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            style={styles.checkboxRow}
            onPress={() => setFinishChapter(value => !value)}>
            <View style={[styles.checkbox, finishChapter && styles.checkboxChecked]}>
              {finishChapter ? <Text style={styles.checkboxMark}>✓</Text> : null}
            </View>
            <View style={styles.checkboxTextWrap}>
              <Text style={styles.checkboxTitle}>Завершить главу</Text>
              <Text style={styles.checkboxMeta}>
                После выбранного времени доиграть текущую часть и остановиться.
              </Text>
            </View>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function Header({
  title,
  leftLabel,
  rightLabel,
  onLeftPress,
  onRightPress,
}: {
  title: string;
  leftLabel?: string;
  rightLabel?: string;
  onLeftPress?: () => void;
  onRightPress?: () => void;
}) {
  return (
    <View style={styles.header}>
      <Pressable style={styles.headerButton} onPress={onLeftPress} disabled={!onLeftPress}>
        <Text style={styles.headerButtonText}>{leftLabel}</Text>
      </Pressable>
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title}
      </Text>
      <Pressable style={styles.headerAction} onPress={onRightPress} disabled={!onRightPress}>
        <Text style={styles.headerActionText}>{rightLabel}</Text>
      </Pressable>
    </View>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: {value: T; label: string}[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map(option => (
        <Pressable
          key={option.value}
          style={[styles.segment, value === option.value && styles.segmentActive]}
          onPress={() => onChange(option.value)}>
          <Text style={[styles.segmentText, value === option.value && styles.segmentTextActive]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function RoundButton({
  label,
  primary,
  onPress,
}: {
  label: string;
  primary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.roundButton, primary && styles.roundButtonPrimary]}
      onPress={onPress}>
      <Text style={[styles.roundButtonText, primary && styles.roundButtonTextPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

function Scrubber({
  value,
  max,
  onChange,
  compact,
}: {
  value: number;
  max: number;
  onChange: (value: number) => void;
  compact?: boolean;
}) {
  const widthRef = useRef(1);
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

  return (
    <Pressable
      style={[styles.scrubber, compact && styles.scrubberCompact]}
      onLayout={event => {
        widthRef.current = event.nativeEvent.layout.width;
      }}
      onPress={event => {
        const nextRatio = event.nativeEvent.locationX / widthRef.current;
        onChange(Math.min(max, Math.max(0, nextRatio * max)));
      }}>
      <View style={[styles.scrubberTrack, compact && styles.scrubberTrackCompact]} />
      <View
        style={[
          styles.scrubberFill,
          compact && styles.scrubberFillCompact,
          {width: `${ratio * 100}%`},
        ]}
      />
      <View
        style={[
          styles.scrubberThumb,
          compact && styles.scrubberThumbCompact,
          {left: `${ratio * 100}%`},
        ]}
      />
    </Pressable>
  );
}

async function requestAudioPermission() {
  if (Platform.OS !== 'android') {
    return false;
  }

  const permission =
    Platform.Version >= 33
      ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO
      : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;

  const result = await PermissionsAndroid.request(permission);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function buildFolders(
  files: AudioFile[],
  sort: FolderSort,
  favoriteFolders: FavoriteFolders,
) {
  const folders = new Map<string, AudioFolder>();

  files.forEach(file => {
    const path = file.folderPath || 'unknown';
    const current = folders.get(path);
    const updatedAt = (file.dateModified ?? file.dateAdded ?? 0) * 1000;

    if (current) {
      current.files.push(file);
      current.updatedAt = Math.max(current.updatedAt, updatedAt);
    } else {
      folders.set(path, {
        name: file.folderName || 'Без папки',
        path,
        files: [file],
        updatedAt,
      });
    }
  });

  const result = [...folders.values()].map(folder => ({
    ...folder,
    files: folder.files.sort((a, b) => naturalCompare(a.fileName, b.fileName)),
  }));

  return result.sort((a, b) => {
    const favoriteDelta = Number(Boolean(favoriteFolders[b.path])) -
      Number(Boolean(favoriteFolders[a.path]));

    if (favoriteDelta !== 0) {
      return favoriteDelta;
    }

    return sort === 'date'
      ? b.updatedAt - a.updatedAt
      : naturalCompare(a.name, b.name);
  });
}

function isCompleted(positionMs: number, durationMs: number) {
  if (durationMs <= 0) {
    return false;
  }

  const remainingMs = durationMs - positionMs;
  return remainingMs <= 15000 || positionMs / durationMs >= 0.97;
}

function isAtTrackEnd(positionMs: number, durationMs: number) {
  if (durationMs <= 0) {
    return false;
  }

  return durationMs - positionMs <= 1500 || positionMs / durationMs >= 0.995;
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
}

function formatCountdown(ms: number) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDate(value: number) {
  if (!value) {
    return 'неизвестно';
  }

  return new Intl.DateTimeFormat('ru', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value));
}

const styles = StyleSheet.create({
  app: {
    flex: 1,
    backgroundColor: '#fff8ec',
  },
  screen: {
    flex: 1,
  },
  header: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#ead8c3',
  },
  headerButton: {
    width: 48,
    height: 44,
    justifyContent: 'center',
  },
  headerButtonText: {
    color: '#151415',
    fontSize: 34,
    lineHeight: 36,
  },
  headerTitle: {
    flex: 1,
    color: '#151415',
    fontSize: 24,
    fontWeight: '700',
  },
  headerAction: {
    minWidth: 56,
    height: 40,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  headerActionText: {
    color: '#ea4f02',
    fontSize: 16,
    fontWeight: '700',
  },
  toolbar: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  muted: {
    color: '#7a604f',
    fontSize: 13,
    fontWeight: '600',
  },
  segmented: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 3,
    borderRadius: 8,
    backgroundColor: '#f6dfc6',
  },
  segment: {
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: '#fffaf3',
  },
  segmentText: {
    color: '#7a604f',
    fontWeight: '700',
  },
  segmentTextActive: {
    color: '#151415',
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
    gap: 10,
  },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fffaf3',
    borderWidth: 1,
    borderColor: '#ead8c3',
  },
  currentRow: {
    backgroundColor: '#fff0df',
    borderColor: '#ea4f02',
  },
  folderIcon: {
    width: 46,
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ea4f02',
  },
  folderIconText: {
    color: '#fffaf3',
    fontSize: 24,
    fontWeight: '800',
  },
  playBadge: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#c13a02',
  },
  completedBadge: {
    backgroundColor: '#9b7b66',
  },
  currentBadge: {
    backgroundColor: '#ea4f02',
  },
  playBadgeText: {
    color: '#fffaf3',
    fontSize: 15,
    fontWeight: '800',
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: '#151415',
    fontSize: 16,
    fontWeight: '700',
  },
  completedTitle: {
    color: '#9b7b66',
  },
  currentTitle: {
    color: '#3c0f01',
  },
  rowMeta: {
    color: '#7a604f',
    fontSize: 13,
  },
  favoriteButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  favoriteButtonText: {
    color: '#b19079',
    fontSize: 28,
    lineHeight: 30,
  },
  favoriteButtonTextActive: {
    color: '#ea4f02',
  },
  chevron: {
    color: '#b19079',
    fontSize: 32,
  },
  empty: {
    marginTop: 48,
    textAlign: 'center',
    color: '#7a604f',
    fontSize: 16,
  },
  playerPanel: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 36,
  },
  bookTitle: {
    color: '#151415',
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
  },
  trackTitle: {
    minHeight: 48,
    marginTop: 10,
    color: '#7a604f',
    fontSize: 18,
    lineHeight: 24,
    textAlign: 'center',
  },
  timeRow: {
    marginTop: 40,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  time: {
    color: '#7a604f',
    fontWeight: '700',
  },
  scrubber: {
    height: 28,
    justifyContent: 'center',
  },
  scrubberCompact: {
    flex: 1,
    height: 24,
  },
  scrubberTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ead8c3',
  },
  scrubberTrackCompact: {
    height: 5,
    borderRadius: 2.5,
  },
  scrubberFill: {
    position: 'absolute',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ea4f02',
  },
  scrubberFillCompact: {
    height: 5,
    borderRadius: 2.5,
  },
  scrubberThumb: {
    position: 'absolute',
    width: 20,
    height: 20,
    marginLeft: -10,
    borderRadius: 10,
    backgroundColor: '#fffaf3',
    borderWidth: 3,
    borderColor: '#ea4f02',
  },
  scrubberThumbCompact: {
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    borderWidth: 2,
  },
  controls: {
    marginTop: 32,
    marginBottom: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
  },
  roundButton: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fffaf3',
    borderWidth: 1,
    borderColor: '#ead8c3',
  },
  roundButtonPrimary: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: '#ea4f02',
    borderColor: '#ea4f02',
  },
  roundButtonText: {
    color: '#151415',
    fontSize: 24,
    fontWeight: '800',
  },
  roundButtonTextPrimary: {
    color: '#fffaf3',
    fontSize: 30,
  },
  sectionLabel: {
    color: '#151415',
    fontSize: 16,
    fontWeight: '800',
  },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 6,
  },
  volumeIcon: {
    width: 20,
    color: '#7a604f',
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
  },
  sleepTimer: {
    marginTop: 22,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#fdebd7',
  },
  sleepTimerTitle: {
    color: '#3c0f01',
    fontSize: 16,
    fontWeight: '800',
  },
  sleepTimerMeta: {
    marginTop: 3,
    color: '#7a604f',
    fontSize: 13,
    fontWeight: '700',
  },
  cancelSleepTimer: {
    alignSelf: 'center',
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  cancelSleepTimerText: {
    color: '#ea4f02',
    fontSize: 13,
    fontWeight: '800',
  },
  nextText: {
    marginTop: 24,
    color: '#7a604f',
    fontSize: 14,
    textAlign: 'center',
  },
  progressHint: {
    marginTop: 8,
    color: '#ea4f02',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  miniPlayer: {
    borderTopWidth: 1,
    borderTopColor: '#ead8c3',
    backgroundColor: '#fffaf3',
  },
  miniProgressTrack: {
    height: 3,
    backgroundColor: '#ead8c3',
  },
  miniProgressFill: {
    height: 3,
    backgroundColor: '#ea4f02',
  },
  miniPlayerRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  miniPlayButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ea4f02',
  },
  miniPlayButtonText: {
    color: '#fffaf3',
    fontSize: 19,
    fontWeight: '900',
  },
  miniPlayerBody: {
    flex: 1,
    gap: 3,
  },
  miniPlayerTitle: {
    color: '#151415',
    fontSize: 15,
    fontWeight: '800',
  },
  miniPlayerMeta: {
    color: '#7a604f',
    fontSize: 12,
    fontWeight: '700',
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalScrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(21, 20, 21, 0.38)',
  },
  sleepModal: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 22,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    backgroundColor: '#fffaf3',
  },
  sleepModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sleepModalTitle: {
    color: '#151415',
    fontSize: 20,
    fontWeight: '900',
  },
  modalCloseButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseText: {
    color: '#7a604f',
    fontSize: 30,
    lineHeight: 32,
  },
  timerOptions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  timerOption: {
    minWidth: 96,
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 8,
    backgroundColor: '#fff0df',
    borderWidth: 1,
    borderColor: '#e7c6a6',
  },
  timerOptionText: {
    color: '#3c0f01',
    fontSize: 15,
    fontWeight: '900',
  },
  checkboxRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#fff8ec',
  },
  checkbox: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#ea4f02',
    backgroundColor: '#fffaf3',
  },
  checkboxChecked: {
    backgroundColor: '#ea4f02',
  },
  checkboxMark: {
    color: '#fffaf3',
    fontSize: 16,
    fontWeight: '900',
  },
  checkboxTextWrap: {
    flex: 1,
    gap: 3,
  },
  checkboxTitle: {
    color: '#151415',
    fontSize: 15,
    fontWeight: '900',
  },
  checkboxMeta: {
    color: '#7a604f',
    fontSize: 13,
    lineHeight: 18,
  },
});

export default App;
