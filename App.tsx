import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
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

type Screen =
  | {name: 'library'}
  | {name: 'folder'; folder: AudioFolder}
  | {name: 'player'; folder: AudioFolder; index: number};

type FolderSort = 'name' | 'date';

const {AudioLibrary, AudioPlayer} = NativeModules as {
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
    getState: () => Promise<PlayerState>;
  };
};

function App() {
  const [screen, setScreen] = useState<Screen>({name: 'library'});
  const [files, setFiles] = useState<AudioFile[]>([]);
  const [folderSort, setFolderSort] = useState<FolderSort>('name');
  const [isScanning, setIsScanning] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>({
    index: -1,
    isPlaying: false,
    durationMs: 0,
    positionMs: 0,
    volume: 1,
  });

  const folders = useMemo(
    () => buildFolders(files, folderSort),
    [files, folderSort],
  );

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

  useEffect(() => {
    if (!AudioPlayer) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const state = await AudioPlayer.getState();
        setPlayerState(state);
      } catch {
        // Player can be empty before the first file is opened.
      }
    }, 700);

    return () => clearInterval(timer);
  }, []);

  const openPlayer = async (folder: AudioFolder, index: number) => {
    if (!AudioPlayer) {
      Alert.alert('Плеер недоступен', 'Нативный модуль AudioPlayer не подключен.');
      return;
    }

    const state = await AudioPlayer.loadQueue(
      folder.files.map(file => file.uri),
      index,
    );
    setPlayerState(state);
    setScreen({name: 'player', folder, index});
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.app}>
        <StatusBar barStyle="dark-content" backgroundColor="#f5f7f4" />
        {screen.name === 'library' ? (
          <LibraryScreen
            folders={folders}
            sort={folderSort}
            isScanning={isScanning}
            onSortChange={setFolderSort}
            onScan={scanLibrary}
            onOpenFolder={folder => setScreen({name: 'folder', folder})}
          />
        ) : null}

        {screen.name === 'folder' ? (
          <FolderScreen
            folder={screen.folder}
            onBack={() => setScreen({name: 'library'})}
            onPlay={index => openPlayer(screen.folder, index)}
          />
        ) : null}

        {screen.name === 'player' ? (
          <PlayerScreen
            folder={screen.folder}
            playerState={playerState}
            onBack={() => setScreen({name: 'folder', folder: screen.folder})}
            onPause={async () => setPlayerState(await AudioPlayer!.pause())}
            onResume={async () => setPlayerState(await AudioPlayer!.resume())}
            onNext={async () => setPlayerState(await AudioPlayer!.next())}
            onPrevious={async () => setPlayerState(await AudioPlayer!.previous())}
            onSeek={async position => setPlayerState(await AudioPlayer!.seekTo(position))}
            onVolume={async volume => setPlayerState(await AudioPlayer!.setVolume(volume))}
          />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function LibraryScreen({
  folders,
  sort,
  isScanning,
  onSortChange,
  onScan,
  onOpenFolder,
}: {
  folders: AudioFolder[];
  sort: FolderSort;
  isScanning: boolean;
  onSortChange: (sort: FolderSort) => void;
  onScan: () => void;
  onOpenFolder: (folder: AudioFolder) => void;
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
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function FolderScreen({
  folder,
  onBack,
  onPlay,
}: {
  folder: AudioFolder;
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
        renderItem={({item, index}) => (
          <Pressable style={styles.row} onPress={() => onPlay(index)}>
            <View style={styles.playBadge}>
              <Text style={styles.playBadgeText}>▶</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.fileName}
              </Text>
              <Text style={styles.rowMeta}>{formatDuration(item.durationMs)}</Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

function PlayerScreen({
  folder,
  playerState,
  onBack,
  onPause,
  onResume,
  onNext,
  onPrevious,
  onSeek,
  onVolume,
}: {
  folder: AudioFolder;
  playerState: PlayerState;
  onBack: () => void;
  onPause: () => void;
  onResume: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (positionMs: number) => void;
  onVolume: (volume: number) => void;
}) {
  const currentFile = folder.files[playerState.index] ?? folder.files[0];
  const nextFile = folder.files[playerState.index + 1];

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

        <Pressable disabled style={styles.sleepTimer}>
          <Text style={styles.sleepTimerTitle}>⏱ Таймер сна</Text>
          <Text style={styles.sleepTimerMeta}>Скоро</Text>
        </Pressable>

        <Text style={styles.nextText} numberOfLines={1}>
          Следующий: {nextFile?.fileName ?? 'конец папки'}
        </Text>
      </View>
    </View>
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

function buildFolders(files: AudioFile[], sort: FolderSort) {
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

  return result.sort((a, b) =>
    sort === 'date' ? b.updatedAt - a.updatedAt : naturalCompare(a.name, b.name),
  );
}

function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'});
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
    backgroundColor: '#f5f7f4',
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
    borderBottomColor: '#d7ddd5',
  },
  headerButton: {
    width: 48,
    height: 44,
    justifyContent: 'center',
  },
  headerButtonText: {
    color: '#17211d',
    fontSize: 34,
    lineHeight: 36,
  },
  headerTitle: {
    flex: 1,
    color: '#111916',
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
    color: '#0f6b5f',
    fontSize: 16,
    fontWeight: '700',
  },
  toolbar: {
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  muted: {
    color: '#61706a',
    fontSize: 13,
    fontWeight: '600',
  },
  segmented: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 3,
    borderRadius: 8,
    backgroundColor: '#dde7e2',
  },
  segment: {
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: '#ffffff',
  },
  segmentText: {
    color: '#61706a',
    fontWeight: '700',
  },
  segmentTextActive: {
    color: '#121a17',
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
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dce4df',
  },
  folderIcon: {
    width: 46,
    height: 46,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f6b5f',
  },
  folderIconText: {
    color: '#ffffff',
    fontSize: 24,
    fontWeight: '800',
  },
  playBadge: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2e6f68',
  },
  playBadgeText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowTitle: {
    color: '#111916',
    fontSize: 16,
    fontWeight: '700',
  },
  rowMeta: {
    color: '#61706a',
    fontSize: 13,
  },
  chevron: {
    color: '#7f8b86',
    fontSize: 32,
  },
  empty: {
    marginTop: 48,
    textAlign: 'center',
    color: '#61706a',
    fontSize: 16,
  },
  playerPanel: {
    flex: 1,
    paddingHorizontal: 22,
    paddingTop: 36,
  },
  bookTitle: {
    color: '#111916',
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
  },
  trackTitle: {
    minHeight: 48,
    marginTop: 10,
    color: '#61706a',
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
    color: '#61706a',
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
    backgroundColor: '#d7dfda',
  },
  scrubberTrackCompact: {
    height: 5,
    borderRadius: 2.5,
  },
  scrubberFill: {
    position: 'absolute',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0f6b5f',
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
    backgroundColor: '#ffffff',
    borderWidth: 3,
    borderColor: '#0f6b5f',
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
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dce4df',
  },
  roundButtonPrimary: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: '#0f6b5f',
    borderColor: '#0f6b5f',
  },
  roundButtonText: {
    color: '#111916',
    fontSize: 24,
    fontWeight: '800',
  },
  roundButtonTextPrimary: {
    color: '#ffffff',
    fontSize: 30,
  },
  sectionLabel: {
    color: '#111916',
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
    color: '#61706a',
    fontSize: 24,
    fontWeight: '900',
    textAlign: 'center',
  },
  sleepTimer: {
    marginTop: 22,
    padding: 14,
    borderRadius: 8,
    backgroundColor: '#e6ece8',
  },
  sleepTimerTitle: {
    color: '#24322d',
    fontSize: 16,
    fontWeight: '800',
  },
  sleepTimerMeta: {
    marginTop: 3,
    color: '#61706a',
    fontSize: 13,
    fontWeight: '700',
  },
  nextText: {
    marginTop: 24,
    color: '#61706a',
    fontSize: 14,
    textAlign: 'center',
  },
});

export default App;
