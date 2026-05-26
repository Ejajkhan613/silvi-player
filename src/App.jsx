import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle,
  CircleHelp,
  FileVideo,
  Gauge,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  Pause,
  PictureInPicture2,
  Play,
  Power,
  RefreshCcw,
  Settings,
  ShieldCheck,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sun,
  Upload,
  Volume2,
  Zap,
} from 'lucide-react';
import { SilviPlayer } from './SilviPlayer';
import './App.css';

const IS_DEV = import.meta.env.DEV;

const STORAGE_KEYS = {
  theme: 'silvi-theme',
  autoSkip: 'skip-enabled',
  settings: 'silvi-settings',
};

const DEFAULT_SETTINGS = {
  minSilenceDuration: 1,
  rmsThreshold: 0.02,
  skipPlaybackRate: 4,
  skipSilenceVolume: 0.01,
  analysisWindow: 0.25,
  fastAudioDecode: true,
};

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const readBoolean = (key, fallback) => {
  const saved = localStorage.getItem(key);
  return saved === null ? fallback : saved === 'true';
};

const readTheme = () => {
  const saved = localStorage.getItem(STORAGE_KEYS.theme);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const clampNumber = (value, min, max, fallback) => {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
};

const sanitizeSettings = (settings = {}) => ({
  minSilenceDuration: clampNumber(
    settings.minSilenceDuration,
    0.3,
    5,
    DEFAULT_SETTINGS.minSilenceDuration,
  ),
  rmsThreshold: clampNumber(settings.rmsThreshold, 0.005, 0.08, DEFAULT_SETTINGS.rmsThreshold),
  skipPlaybackRate: clampNumber(
    settings.skipPlaybackRate,
    1.25,
    8,
    DEFAULT_SETTINGS.skipPlaybackRate,
  ),
  skipSilenceVolume: clampNumber(
    settings.skipSilenceVolume,
    0,
    0.3,
    DEFAULT_SETTINGS.skipSilenceVolume,
  ),
  analysisWindow: clampNumber(settings.analysisWindow, 0.1, 1, DEFAULT_SETTINGS.analysisWindow),
  fastAudioDecode: settings.fastAudioDecode ?? DEFAULT_SETTINGS.fastAudioDecode,
});

const readSettings = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || '{}');
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  } catch {
    return DEFAULT_SETTINGS;
  }
};

const formatFileSize = (size) => {
  if (!size) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatTime = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
};

function SettingSlider({ icon, label, description, value, min, max, step, suffix = '', onChange }) {
  const IconComponent = icon;

  return (
    <label className="setting-control">
      <span className="setting-label">
        <IconComponent size={17} strokeWidth={2.2} />
        {label}
        <span
          className="tooltip-trigger"
          tabIndex="0"
          aria-label={description}
        >
          <CircleHelp size={14} strokeWidth={2.3} />
          <span className="tooltip-bubble" role="tooltip">
            {description}
          </span>
        </span>
      </span>
      <span className="setting-value">
        {Number(value).toFixed(step < 0.01 ? 3 : step < 1 ? 2 : 1)}
        {suffix}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function App() {
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const videoShellRef = useRef(null);
  const playerCardRef = useRef(null);
  const objectUrlRef = useRef(null);
  const playerRef = useRef(null);
  const attachedPlayerRef = useRef(null);
  const analysisDebounceRef = useRef(null);

  const [theme, setTheme] = useState(readTheme);
  const [autoSkipEnabled, setAutoSkipEnabled] = useState(() =>
    readBoolean(STORAGE_KEYS.autoSkip, true),
  );
  const [settings, setSettings] = useState(readSettings);
  const [selectedFile, setSelectedFile] = useState(null);
  const [videoDuration, setVideoDuration] = useState(null);
  const [status, setStatus] = useState('Choose a local video to begin');
  const [isProcessing, setIsProcessing] = useState(false);
  const [needsAnalysis, setNeedsAnalysis] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPictureInPicture, setIsPictureInPicture] = useState(false);

  if (playerRef.current === null) {
    playerRef.current = new SilviPlayer({
      ...settings,
      normalPlaybackRate: playbackRate,
      debug: IS_DEV,
    });
  }

  const handleStatusChange = useCallback((nextStatus) => {
    setStatus(nextStatus);

    if (
      nextStatus === 'Ready' ||
      nextStatus.startsWith('Error') ||
      nextStatus.startsWith('Worker Error')
    ) {
      setIsProcessing(false);
    }
  }, []);

  const attachPlayer = useCallback(
    (player) => {
      if (!player || !videoRef.current || attachedPlayerRef.current === player) return;

      if (attachedPlayerRef.current) {
        attachedPlayerRef.current.detach();
      }

      player.attach(videoRef.current, {
        onStatusChange: handleStatusChange,
      });
      attachedPlayerRef.current = player;
    },
    [handleStatusChange],
  );

  const createConfiguredPlayer = useCallback(
    (shouldAttach) => {
      playerRef.current?.detach();
      attachedPlayerRef.current = null;

      const player = new SilviPlayer({
        ...settings,
        normalPlaybackRate: playbackRate,
        debug: IS_DEV,
      });

      playerRef.current = player;
      if (shouldAttach) attachPlayer(player);
      return player;
    },
    [attachPlayer, playbackRate, settings],
  );

  const analyzeFile = useCallback(
    async (file = selectedFile, options = {}) => {
      if (!file) return;

      const shouldAttach = options.attach ?? autoSkipEnabled;
      const player = createConfiguredPlayer(shouldAttach);

      setIsProcessing(true);
      setNeedsAnalysis(false);
      setStatus(shouldAttach ? 'Preparing analysis...' : 'Preparing analysis');

      try {
        await player.processFile(file);
        setNeedsAnalysis(false);
      } catch (error) {
        setIsProcessing(false);
        setNeedsAnalysis(true);
        setStatus(`Error: ${error.message}`);
      }
    },
    [autoSkipEnabled, createConfiguredPlayer, selectedFile],
  );

  const loadVideoFile = useCallback(
    (file) => {
      if (!file) return;

      if (!file.type.startsWith('video/') && !/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(file.name)) {
        setStatus('Select a video file');
        return;
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }

      const objectUrl = URL.createObjectURL(file);
      objectUrlRef.current = objectUrl;

      setSelectedFile(file);
      setVideoDuration(null);
      setCurrentTime(0);
      setIsPlaying(false);
      setNeedsAnalysis(!autoSkipEnabled);

      if (videoRef.current) {
        videoRef.current.src = objectUrl;
        videoRef.current.load();
        videoRef.current.playbackRate = playbackRate;
        videoRef.current.play().then(() => {
          setIsPlaying(true);
        }).catch(() => {
          // Some browsers still block unmuted autoplay after file selection.
        });
      }

      if (autoSkipEnabled) {
        void analyzeFile(file, { attach: true });
      } else {
        playerRef.current?.detach();
        attachedPlayerRef.current = null;
        setIsProcessing(false);
        setStatus('Ready. Auto-skip is off');
      }
    },
    [analyzeFile, autoSkipEnabled, playbackRate],
  );

  const handleFileInput = (event) => {
    const file = event.target.files?.[0];
    loadVideoFile(file);
    event.target.value = '';
  };

  const handleDrop = (event) => {
    event.preventDefault();
    setIsDragging(false);
    loadVideoFile(event.dataTransfer.files?.[0]);
  };

  const handleAutoSkipChange = (checked) => {
    setAutoSkipEnabled(checked);

    if (!checked) {
      playerRef.current?.detach();
      attachedPlayerRef.current = null;
      setStatus(selectedFile ? 'Ready. Auto-skip is off' : 'Choose a local video to begin');
      return;
    }

    if (selectedFile && needsAnalysis) {
      void analyzeFile(selectedFile, { attach: true });
      return;
    }

    attachPlayer(playerRef.current);
    setStatus(selectedFile ? 'Auto-skip enabled' : 'Choose a local video to begin');
  };

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || !selectedFile) {
      fileInputRef.current?.click();
      return;
    }

    if (video.paused || video.ended) {
      video.play().then(() => setIsPlaying(true)).catch((error) => {
        setStatus(`Playback blocked: ${error.message}`);
      });
      return;
    }

    video.pause();
  };

  const seekTo = (nextTime) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;

    const clampedTime = Math.min(video.duration, Math.max(0, nextTime));
    video.currentTime = clampedTime;
    setCurrentTime(clampedTime);
  };

  const skipBy = (seconds) => {
    seekTo((videoRef.current?.currentTime ?? 0) + seconds);
  };

  const handlePlaybackRateChange = (nextPlaybackRate) => {
    setPlaybackRate(nextPlaybackRate);
    playerRef.current?.setNormalPlaybackRate?.(nextPlaybackRate);

    if (videoRef.current && (!autoSkipEnabled || !playerRef.current)) {
      videoRef.current.playbackRate = nextPlaybackRate;
    }
  };

  const toggleFullscreen = async () => {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;

    try {
      if (fullscreenElement) {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else {
          document.webkitExitFullscreen?.();
        }
        return;
      }

      if (playerCardRef.current?.requestFullscreen) {
        await playerCardRef.current.requestFullscreen();
        return;
      }

      playerCardRef.current?.webkitRequestFullscreen?.();
    } catch (error) {
      setStatus(`Fullscreen unavailable: ${error.message}`);
    }
  };

  const togglePictureInPicture = async () => {
    const video = videoRef.current;
    if (!video || !document.pictureInPictureEnabled) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      await video.requestPictureInPicture();
    } catch (error) {
      setStatus(`Picture-in-picture unavailable: ${error.message}`);
    }
  };

  const updateSetting = (key, value) => {
    setSettings((current) => sanitizeSettings({ ...current, [key]: value }));
    if (selectedFile) setNeedsAnalysis(true);
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    if (selectedFile) setNeedsAnalysis(true);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.autoSkip, String(autoSkipEnabled));
  }, [autoSkipEnabled]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    const preventContextMenu = (event) => event.preventDefault();
    document.addEventListener('contextmenu', preventContextMenu);

    return () => {
      document.removeEventListener('contextmenu', preventContextMenu);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;

    const handleLoadedMetadata = () => {
      setVideoDuration(video.duration);
      setCurrentTime(video.currentTime);
    };
    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => {
      setIsPlaying(false);
      setCurrentTime(video.duration || 0);
    };
    const handleEnterPictureInPicture = () => setIsPictureInPicture(true);
    const handleLeavePictureInPicture = () => setIsPictureInPicture(false);

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('enterpictureinpicture', handleEnterPictureInPicture);
    video.addEventListener('leavepictureinpicture', handleLeavePictureInPicture);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('enterpictureinpicture', handleEnterPictureInPicture);
      video.removeEventListener('leavepictureinpicture', handleLeavePictureInPicture);
    };
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      setIsFullscreen(
        fullscreenElement === playerCardRef.current ||
        fullscreenElement === videoShellRef.current ||
        fullscreenElement === videoRef.current,
      );
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (autoSkipEnabled) {
      attachPlayer(playerRef.current);
    }
  }, [attachPlayer, autoSkipEnabled]);

  useEffect(() => {
    if (!selectedFile || !autoSkipEnabled || !needsAnalysis || isProcessing) return undefined;

    analysisDebounceRef.current = setTimeout(() => {
      void analyzeFile(selectedFile, { attach: true });
    }, 700);

    return () => {
      clearTimeout(analysisDebounceRef.current);
    };
  }, [analyzeFile, autoSkipEnabled, isProcessing, needsAnalysis, selectedFile]);

  useEffect(
    () => () => {
      clearTimeout(analysisDebounceRef.current);
      playerRef.current?.detach();
      attachedPlayerRef.current = null;

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    },
    [],
  );

  const statusKind = useMemo(() => {
    if (status.startsWith('Error')) return 'error';
    if (status === 'Ready' || status.startsWith('Auto-skip enabled')) return 'ready';
    if (isProcessing) return 'working';
    return 'idle';
  }, [isProcessing, status]);

  const fileDetails = useMemo(
    () => [
      { label: 'File', value: selectedFile?.name || 'No video selected' },
      { label: 'Size', value: selectedFile ? formatFileSize(selectedFile.size) : '--' },
      { label: 'Duration', value: formatTime(videoDuration) },
      { label: 'Mode', value: autoSkipEnabled ? 'Auto-skip on' : 'Auto-skip off' },
    ],
    [autoSkipEnabled, selectedFile, videoDuration],
  );

  const durationSeconds = Number.isFinite(videoDuration) ? videoDuration : 0;
  const progressPercent = durationSeconds > 0 ? (currentTime / durationSeconds) * 100 : 0;
  const canUsePictureInPicture = Boolean(
    selectedFile &&
    document.pictureInPictureEnabled &&
    videoRef.current &&
    !videoRef.current.disablePictureInPicture,
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <Activity size={22} />
        </div>
        <div className="brand-copy">
          <h1>Silvi Player</h1>
          <p>Local video player for fast silence skipping</p>
        </div>
        <a
          className="package-link"
          href="https://www.npmjs.com/package/silvi-player"
          target="_blank"
          rel="noreferrer"
        >
          npm package
        </a>
        <button
          type="button"
          className="icon-button theme-button"
          onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
        </button>
      </header>

      <section className="workspace">
        <div className="player-card" ref={playerCardRef}>
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="video/*"
            onChange={handleFileInput}
          />

          <div className="video-shell" ref={videoShellRef}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              onClick={togglePlayback}
              onDoubleClick={() => void toggleFullscreen()}
            />

            {!selectedFile && (
              <div
                className={`drop-layer ${isDragging ? 'is-dragging' : ''}`}
                role="button"
                tabIndex="0"
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
              >
                <Upload size={34} />
                <strong>Click or drop a video here</strong>
                <span>Works locally. No upload.</span>
              </div>
            )}
          </div>

          <div className="custom-controls">
            <div className="seek-row">
              <span>{formatTime(currentTime)}</span>
              <input
                className="seek-slider"
                type="range"
                min="0"
                max={durationSeconds || 0}
                step="0.1"
                value={Math.min(currentTime, durationSeconds || currentTime)}
                onChange={(event) => seekTo(Number(event.target.value))}
                style={{ '--progress': `${progressPercent}%` }}
                disabled={!selectedFile || durationSeconds === 0}
                aria-label="Seek video"
              />
              <span>{formatTime(durationSeconds)}</span>
            </div>

            <div className="control-row">
              <div className="control-group">
                <button
                  type="button"
                  className="control-button"
                  onClick={() => skipBy(-10)}
                  disabled={!selectedFile}
                  title="Back 10 seconds"
                  aria-label="Back 10 seconds"
                >
                  <SkipBack size={18} />
                </button>

                <button
                  type="button"
                  className="control-button primary-control"
                  onClick={togglePlayback}
                  disabled={!selectedFile}
                  title={isPlaying ? 'Pause' : 'Play'}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause size={20} /> : <Play size={20} />}
                </button>

                <button
                  type="button"
                  className="control-button"
                  onClick={() => skipBy(10)}
                  disabled={!selectedFile}
                  title="Forward 10 seconds"
                  aria-label="Forward 10 seconds"
                >
                  <SkipForward size={18} />
                </button>
              </div>

              <div className="control-group option-group">
                <select
                  className="speed-select"
                  value={playbackRate}
                  onChange={(event) => handlePlaybackRateChange(Number(event.target.value))}
                  disabled={!selectedFile}
                  aria-label="Playback speed"
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}x
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className={`control-button ${isPictureInPicture ? 'is-active' : ''}`}
                  onClick={() => void togglePictureInPicture()}
                  disabled={!canUsePictureInPicture}
                  title="Picture in picture"
                  aria-label="Picture in picture"
                >
                  <PictureInPicture2 size={18} />
                </button>

                <button
                  type="button"
                  className="control-button"
                  onClick={() => void toggleFullscreen()}
                  disabled={!selectedFile}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
              </div>
            </div>
          </div>

          <div className={`transport-panel ${statusKind}`} aria-live="polite">
            <div className="status-inline">
              {statusKind === 'working' ? (
                <Loader2 className="spin" size={18} />
              ) : statusKind === 'ready' ? (
                <CheckCircle size={18} />
              ) : statusKind === 'error' ? (
                <Power size={18} />
              ) : (
                <Play size={18} />
              )}
              <span>{status}</span>
              {needsAnalysis && selectedFile && <strong>Settings changed</strong>}
            </div>

            <div className="toolbar-actions">
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={autoSkipEnabled}
                  onChange={(event) => handleAutoSkipChange(event.target.checked)}
                />
                <span className="switch-track" aria-hidden="true">
                  <span />
                </span>
                <span>Auto-skip</span>
              </label>

              <button
                type="button"
                className={`settings-toggle ${isSettingsOpen ? 'is-active' : ''}`}
                onClick={() => setIsSettingsOpen((current) => !current)}
                aria-expanded={isSettingsOpen}
                aria-controls="tuning-settings"
              >
                <SlidersHorizontal size={18} />
                Settings
              </button>
            </div>
          </div>

          {isSettingsOpen && (
            <section className="settings-panel" id="tuning-settings">
              <div className="settings-panel-header">
                <div className="section-heading">
                  <SlidersHorizontal size={18} />
                  <h2>Tuning</h2>
                </div>

                <div className="settings-meta">
                  <FileVideo size={16} />
                  <span title={selectedFile?.name || ''}>{selectedFile?.name || 'No video selected'}</span>
                </div>
              </div>

              <div className="settings-stack">
                <SettingSlider
                  icon={Activity}
                  label="Silence length"
                  description="Minimum quiet duration before a segment is treated as silence."
                  value={settings.minSilenceDuration}
                  min={0.3}
                  max={5}
                  step={0.1}
                  suffix="s"
                  onChange={(value) => updateSetting('minSilenceDuration', value)}
                />
                <SettingSlider
                  icon={Gauge}
                  label="RMS threshold"
                  description="Audio loudness cutoff. Lower values require quieter audio to count as silence."
                  value={settings.rmsThreshold}
                  min={0.005}
                  max={0.08}
                  step={0.001}
                  onChange={(value) => updateSetting('rmsThreshold', value)}
                />
                <SettingSlider
                  icon={Zap}
                  label="Skip speed"
                  description="Playback speed used while Silvi is passing through detected silent parts."
                  value={settings.skipPlaybackRate}
                  min={1.25}
                  max={8}
                  step={0.25}
                  suffix="x"
                  onChange={(value) => updateSetting('skipPlaybackRate', value)}
                />
                <SettingSlider
                  icon={Volume2}
                  label="Skip volume"
                  description="Volume multiplier during silent skips so fast-forwarded audio stays unobtrusive."
                  value={settings.skipSilenceVolume}
                  min={0}
                  max={0.3}
                  step={0.01}
                  onChange={(value) => updateSetting('skipSilenceVolume', value)}
                />
                <SettingSlider
                  icon={Settings}
                  label="Window"
                  description="Audio analysis window size. Smaller windows are more precise; larger windows process faster."
                  value={settings.analysisWindow}
                  min={0.1}
                  max={1}
                  step={0.05}
                  suffix="s"
                  onChange={(value) => updateSetting('analysisWindow', value)}
                />
              </div>

              <div className="settings-footer">
                <div className="detail-grid">
                  {fileDetails.slice(1).map((item) => (
                    <div key={item.label} className="detail-item">
                      <span>{item.label}</span>
                      <strong title={item.value}>{item.value}</strong>
                    </div>
                  ))}
                </div>

                <div className="settings-footer-actions">
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={settings.fastAudioDecode}
                      onChange={(event) => updateSetting('fastAudioDecode', event.target.checked)}
                    />
                    <span>
                      <ShieldCheck size={17} />
                      MP4 audio-only
                    </span>
                  </label>

                  <button type="button" className="ghost-action" onClick={resetSettings}>
                    <RefreshCcw size={17} />
                    Reset
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      </section>
    </main>
  );
}

export default App;
