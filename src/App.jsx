// App.jsx

import { useRef, useEffect, useState } from 'react';
import './App.css';

const IS_DEV = true;

function App() {
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const skipToggleRef = useRef(null);
  const statusMessageRef = useRef(null);
  const skipIndicatorRef = useRef(null);

  const [isHovering, setIsHovering] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);

  const minSilenceDuration = 1.0;
  const rmsThreshold = 0.02;
  const sampleStep = 1024;

  const CHUNK_DURATION = 300;
  const PRELOAD_THRESHOLD = 60;
  const [silentRangesMap, setSilentRangesMap] = useState(new Map());
  const [processedChunks, setProcessedChunks] = useState(new Set());

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const logMessage = (msg) => {
    const logDiv = document.getElementById('log');
    if (logDiv) {
      logDiv.innerHTML += `<div>${msg}</div>`;
      logDiv.scrollTop = logDiv.scrollHeight;
    }
  };

  const showStatus = (msg) => {
    if (statusMessageRef.current) {
      statusMessageRef.current.textContent = msg;
    }
  };

  const showSkipMessage = () => {
    if (skipIndicatorRef.current) {
      skipIndicatorRef.current.style.display = 'block';
      setTimeout(() => {
        if (skipIndicatorRef.current) {
          skipIndicatorRef.current.style.display = 'none';
        }
      }, 1000);
    }
  };

  const processAudioChunk = async (file, chunkIndex) => {
    if (processedChunks.has(chunkIndex)) return;

    const startTime = chunkIndex * CHUNK_DURATION;
    const endTime = startTime + CHUNK_DURATION;

    showStatus(`⏳ Processing part ${chunkIndex + 1}...`);

    try {
      const arrayBuffer = await file.slice(0).arrayBuffer();

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);

      const sampleRate = decodedBuffer.sampleRate;
      const startSample = Math.floor(startTime * sampleRate);
      const endSample = Math.min(decodedBuffer.length, Math.floor(endTime * sampleRate));
      const chunkData = decodedBuffer.getChannelData(0).slice(startSample, endSample);

      workerRef.current.postMessage({
        chunkIndex,
        chunkData,
        sampleRate,
        startTime,
        endTime,
        rmsThreshold,
        sampleStep,
        minSilenceDuration
      });

      audioCtx.close();
    } catch (error) {
      showStatus(`❌ Error decoding audio: ${error.message}`);
    }
  };


  let preloadTimeout;

  const autoSkipSilence = () => {
    const video = videoRef.current;
    const skipToggle = skipToggleRef.current;

    if (!skipToggle.checked || video.paused || video.ended) {
      requestAnimationFrame(autoSkipSilence);
      return;
    }

    const time = video.currentTime;
    const currentChunk = Math.floor(time / CHUNK_DURATION);

    if (
      !processedChunks.has(currentChunk + 1) &&
      time % CHUNK_DURATION >= CHUNK_DURATION - PRELOAD_THRESHOLD
    ) {
      if (!preloadTimeout) {
        preloadTimeout = setTimeout(() => {
          processAudioChunk(fileInputRef.current.files[0], currentChunk + 1);
          preloadTimeout = null;
        }, 1000); // Only load one chunk per second max
      }
    }

    const silentRanges = silentRangesMap.get(currentChunk) || [];
    const inSilent = silentRanges.some(([start, end]) => time >= start && time < end);

    if (inSilent && video.playbackRate !== 4) {
      video.playbackRate = 4;
      showSkipMessage();
    } else if (!inSilent && video.playbackRate !== 1) {
      video.playbackRate = 1;
    }

    requestAnimationFrame(autoSkipSilence);
  };

  const workerRef = useRef(null);


  useEffect(() => {
    // With Vite or Webpack
    workerRef.current = new Worker(new URL('./audioWorker.js', import.meta.url), {
      type: 'module',
    });


    workerRef.current.onmessage = (e) => {
      const { chunkIndex, silentRanges, error } = e.data;

      if (error) {
        showStatus(`❌ Worker error: ${error}`);
        return;
      }

      setSilentRangesMap((prev) => {
        const newMap = new Map(prev);
        newMap.set(chunkIndex, silentRanges);
        return newMap;
      });

      setProcessedChunks((prev) => new Set(prev).add(chunkIndex));
      logMessage(`✅ Processing finished of part ${chunkIndex + 1}`);
      showStatus('✅ Ready to play');
    };

    return () => {
      workerRef.current?.terminate();
    };
  }, []);




  useEffect(() => {
    const fileInput = fileInputRef.current;
    const video = videoRef.current;

    const handleFileChange = () => {
      const file = fileInput.files[0];
      if (!file) return;

      const videoURL = URL.createObjectURL(file);
      video.src = videoURL;
      video.load();

      const skipEnabled = skipToggleRef.current.checked;

      if (skipEnabled) {
        showStatus('🔄 Auto-skip enabled. Processing first chunk...');
        processAudioChunk(file, 0);
      } else {
        showStatus('✅ Ready. Auto-skip disabled.');
      }
    };

    const handleMouseEnter = () => setIsHovering(true);
    const handleMouseLeave = () => setIsHovering(false);
    const handlePlay = () => requestAnimationFrame(autoSkipSilence);
    const handleEnded = () => {
      if (IS_DEV) console.log('Final silent ranges:', silentRangesMap);
    };

    fileInput.addEventListener('change', handleFileChange);
    video.addEventListener('mouseenter', handleMouseEnter);
    video.addEventListener('mouseleave', handleMouseLeave);
    video.addEventListener('play', handlePlay);
    video.addEventListener('ended', handleEnded);

    return () => {
      fileInput.removeEventListener('change', handleFileChange);
      video.removeEventListener('mouseenter', handleMouseEnter);
      video.removeEventListener('mouseleave', handleMouseLeave);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('ended', handleEnded);
    };
  }, [silentRangesMap, processedChunks]);

  useEffect(() => {
    document.body.classList.toggle('dark-mode', isDarkMode);
  }, [isDarkMode]);

  return (
    <>
      <h2>🎬 Silvi Player</h2>
      <div className="controls">
        <input ref={fileInputRef} type="file" accept="video/*" />
        <label>
          <input ref={skipToggleRef} type="checkbox" defaultChecked />
          Auto-Skip Silence
        </label>
        <button className="theme-toggle" onClick={() => setIsDarkMode(prev => !prev)}>
          {isDarkMode ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>
      </div>

      <div ref={statusMessageRef}>Please select a video to begin.</div>
      <div id="log" style={{ fontSize: '0.9em', color: '#666', marginTop: '1em', maxHeight: '120px', overflowY: 'auto' }}></div>
      <div ref={skipIndicatorRef} style={{ display: 'none', fontWeight: 'bold', marginTop: '1em' }}>
        ⏩ Skipping silence...
      </div>
      <video ref={videoRef} controls style={{ width: '100%', marginTop: '1em' }}></video>
    </>
  );
}

export default App;