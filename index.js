const fileInput = document.getElementById('fileInput');
const video = document.getElementById('videoPlayer');
const skipToggle = document.getElementById('skipToggle');
const statusMessage = document.getElementById('statusMessage');
const skipIndicator = document.getElementById('skipIndicator');

let isHovering = false;
const IS_DEV = true; // Set to true for development

let silentRanges = [];

const minSilenceDuration = 1.0; // seconds
const rmsThreshold = 0.02;      // lower = more sensitive
const sampleStep = 1024;        // how many audio samples per chunk

let isSeeking = false;

function showStatus(msg) {
    statusMessage.textContent = msg;
}

function showSkipMessage() {
    skipIndicator.style.display = 'block';
    setTimeout(() => {
        skipIndicator.style.display = 'none';
    }, 1000);
}

function detectSilenceInAudioBuffer(buffer, sampleRate) {
    const data = buffer.getChannelData(0);
    const length = data.length;
    const duration = buffer.duration;
    let silenceStart = null;

    for (let i = 0; i < length; i += sampleStep) {
        let sum = 0;
        for (let j = i; j < i + sampleStep && j < length; j++) {
            sum += data[j] * data[j];
        }

        const rms = Math.sqrt(sum / sampleStep);
        const currentTime = i / sampleRate;

        if (rms < rmsThreshold) {
            if (silenceStart === null) {
                silenceStart = currentTime;
            }
        } else {
            if (silenceStart !== null && currentTime - silenceStart >= minSilenceDuration) {
                silentRanges.push([silenceStart, currentTime]);
                if (IS_DEV) console.log('Silent range:', silenceStart.toFixed(2), '→', currentTime.toFixed(2));
            }
            silenceStart = null;
        }
    }

    // End with silence
    if (silenceStart !== null && (duration - silenceStart) >= minSilenceDuration) {
        silentRanges.push([silenceStart, duration]);
    }
}


function processAudio(file) {
    if (IS_DEV) console.log("Audio Processing Started");
    showStatus('🔄 Processing audio...');
    const reader = new FileReader();
    reader.onload = async () => {
        const arrayBuffer = reader.result;
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        try {
            const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
            if (IS_DEV) console.log('🔍 Processing audio to detect silence...');
            silentRanges = [];
            detectSilenceInAudioBuffer(decodedBuffer, decodedBuffer.sampleRate);
            if (IS_DEV) console.log('✅ Silence detection complete.');
            showStatus('✅ Silence detection complete. Ready to play.');
        } catch (err) {
            if (IS_DEV) console.error('❌ Failed to decode audio:', err);
            showStatus('❌ Failed to process audio.');
        }
    };
    reader.readAsArrayBuffer(file);
}



// File load event
fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;

    const videoURL = URL.createObjectURL(file);
    video.src = videoURL;
    video.load();

    if (skipToggle.checked) {
        processAudio(file); // Starting audio processing as soon as file is selected
    }
});

function autoSkipSilence() {
    if (!skipToggle.checked || isSeeking || video.paused || video.ended) {
        requestAnimationFrame(autoSkipSilence);
        return;
    }

    const time = video.currentTime;

    for (let i = 0; i < silentRanges.length; i++) {
        const [start, end] = silentRanges[i];
        if (time >= start && time < end) {
            if (IS_DEV) console.log(`⏩ Skipping silent part: ${start.toFixed(2)}s → ${end.toFixed(2)}s`);
            isSeeking = true;

            if (!isHovering) {
                video.controls = false;
            }

            showSkipMessage();

            const onSeeked = () => {
                isSeeking = false;
                video.controls = true;
                video.removeEventListener('seeked', onSeeked);
            };

            video.addEventListener('seeked', onSeeked);

            if (typeof video.fastSeek === 'function') {
                video.fastSeek(end);
            } else {
                video.currentTime = end;
            }

            break;
        }
    }

    requestAnimationFrame(autoSkipSilence);
}


video.addEventListener('mouseenter', () => {
    isHovering = true;
});

video.addEventListener('mouseleave', () => {
    isHovering = false;
});


video.addEventListener('play', () => {
    requestAnimationFrame(autoSkipSilence);
});

video.addEventListener('ended', () => {
    if (IS_DEV) console.log('Final silent ranges:', silentRanges);
});