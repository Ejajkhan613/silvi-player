import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CheckCircle,
  CircleHelp,
  FileVideo,
  Gauge,
  Loader2,
  Moon,
  Play,
  Power,
  RefreshCcw,
  Settings,
  ShieldCheck,
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

  if (playerRef.current === null) {
    playerRef.current = new SilviPlayer({ ...settings, debug: IS_DEV });
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
        debug: IS_DEV,
      });

      playerRef.current = player;
      if (shouldAttach) attachPlayer(player);
      return player;
    },
    [attachPlayer, settings],
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
      setNeedsAnalysis(!autoSkipEnabled);

      if (videoRef.current) {
        videoRef.current.src = objectUrl;
        videoRef.current.load();
        videoRef.current.playbackRate = 1;
        videoRef.current.play().catch(() => {
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
    [analyzeFile, autoSkipEnabled],
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
        <div className="player-card">
          <input
            ref={fileInputRef}
            className="sr-only"
            type="file"
            accept="video/*"
            onChange={handleFileInput}
          />

          <div className="video-shell">
            <video
              ref={videoRef}
              autoPlay
              controls
              playsInline
              onLoadedMetadata={() => setVideoDuration(videoRef.current?.duration ?? null)}
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
                <span>Local files only. Nothing is uploaded.</span>
              </div>
            )}
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
