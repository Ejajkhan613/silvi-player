import { useRef, useEffect, useState } from 'react';
import './App.css';

const IS_DEV = import.meta.env.VITE_NODE_ENV === 'development';

function App() {
  const fileInputRef = useRef(null);
  const videoRef = useRef(null);
  const skipToggleRef = useRef(null);
  const statusMessageRef = useRef(null);
  const skipIndicatorRef = useRef(null);

  const [isDarkMode, setIsDarkMode] = useState(localStorage.getItem('dark-mode') === 'true');
  const [performanceMetrics, setPerformanceMetrics] = useState(null);

  useEffect(() => {
    document.body.classList.toggle('dark-mode', isDarkMode);
  }, [isDarkMode]);

  const minSilenceDuration = 1.0;
  const rmsThreshold = 0.02;
  const sampleStep = 1024;

  const CHUNK_DURATION = 300;
  const [silentRangesMap, setSilentRangesMap] = useState(new Map());

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
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

  const processingStartTimeRef = useRef(null);

  const processFullAudio = async (file) => {
    processingStartTimeRef.current = performance.now();
    const startTimestamp = new Date().toISOString();
    showStatus("Audio Decoding Started");

    try {
      const arrayBuffer = await file.arrayBuffer();
      // Use a lower sample rate to reduce memory and processing time
      const targetSampleRate = 16000;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: targetSampleRate
      });

      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const audioData = decodedBuffer.getChannelData(0);

      if (IS_DEV) {
        const memory = architecture.getMemoryUsage();
        console.log(`[Silvi-Player] Processing Started at ${startTimestamp}`);
        console.log(`[Silvi-Player] Audio Duration: ${decodedBuffer.duration.toFixed(2)}s`);
        console.log(`[Silvi-Player] Sample Rate: ${decodedBuffer.sampleRate}Hz`);
        console.log(`[Silvi-Player] Data Points: ${audioData.length}`);
        if (memory) console.log(`[Silvi-Player] Estimated Heap: ${(memory / 1024 / 1024).toFixed(2)} MB`);
      }

      workerRef.current.postMessage({
        audioData,
        sampleRate: decodedBuffer.sampleRate,
        rmsThreshold,
        sampleStep,
        minSilenceDuration
      }, [audioData.buffer]); // Transferable Object

      audioCtx.close();
    } catch (error) {
      showStatus(`❌ Audio Decode Error: ${error.message}`);
    }
  };

  const architecture = {
    getMemoryUsage: () => {
      if (window.performance && window.performance.memory) {
        return window.performance.memory.usedJSHeapSize;
      }
      return null;
    }
  };



  const autoSkipSilence = () => {
    const video = videoRef.current;
    const skipToggle = skipToggleRef.current;

    if (!skipToggle.checked || video.paused || video.ended) {
      requestAnimationFrame(autoSkipSilence);
      return;
    }

    const time = video.currentTime;
    const currentChunk = Math.floor(time / CHUNK_DURATION);

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
      const { silentRange, done, error } = e.data;

      if (error) {
        showStatus(`❌ Worker Error: ${error}`);
        return;
      }


      if (silentRange) {
        setSilentRangesMap((prev) => {
          const newMap = new Map(prev);
          const chunk = Math.floor(silentRange[0] / CHUNK_DURATION);
          const ranges = newMap.get(chunk) || [];
          ranges.push(silentRange);
          newMap.set(chunk, ranges);
          return newMap;
        });
      }

      if (done) {
        const endTime = performance.now();
        const duration = endTime - processingStartTimeRef.current;
        showStatus('✅ Detection Completed');

        if (IS_DEV) {
          const memory = architecture.getMemoryUsage();
          console.log(`[Silvi-Player] Processing Completed at ${new Date().toISOString()}`);
          console.log(`[Silvi-Player] Total Processing Time: ${duration.toFixed(2)}ms`);
          if (memory) console.log(`[Silvi-Player] Final Estimated Heap: ${(memory / 1024 / 1024).toFixed(2)} MB`);
        }

        const video = videoRef.current;
        if (video && video.paused && video.readyState >= 2) {
          video.play().catch(err => {
            console.error("⚠️ Couldn't Auto-Play Video:", err.message);
          });
        }
      }
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
        showStatus('🔄 Auto-Skip Enabled. Processing Audio...');
        processFullAudio(file);
      } else {
        showStatus('✅ Ready. Auto-Skip Disabled');
      }
    };

    const handlePlay = () => requestAnimationFrame(autoSkipSilence);
    const handleEnded = () => {
      if (IS_DEV) console.log('Final silent ranges:', silentRangesMap);
    };

    fileInput.addEventListener('change', handleFileChange);
    video.addEventListener('play', handlePlay);
    video.addEventListener('ended', handleEnded);

    return () => {
      fileInput.removeEventListener('change', handleFileChange);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('ended', handleEnded);
    };
  }, [silentRangesMap]);

  useEffect(() => {
    const savedDark = localStorage.getItem('dark-mode') === 'true';
    setIsDarkMode(savedDark);

    const savedSkip = localStorage.getItem('skip-enabled') === 'true';
    skipToggleRef.current.checked = savedSkip;
  }, []);

  useEffect(() => {
    localStorage.setItem('dark-mode', isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    const checkbox = skipToggleRef.current;
    const handler = () => {
      localStorage.setItem('skip-enabled', checkbox.checked);
    };
    checkbox.addEventListener('change', handler);
    return () => checkbox.removeEventListener('change', handler);
  }, []);


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

      <div ref={statusMessageRef}><b>Please Select a Video to Begin</b></div>
      <div id="log" style={{ fontSize: '0.9em', color: '#666', marginTop: '1em', maxHeight: '120px', overflowY: 'auto' }}></div>
      <div ref={skipIndicatorRef} style={{ display: 'none', fontWeight: 'bold', marginTop: '1em' }}>
        ⏩ Skipping...
      </div>
      <video ref={videoRef} controls style={{ width: '100%', marginTop: '1em' }}></video>
    </>
  );
}

export default App;