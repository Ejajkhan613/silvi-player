self.onmessage = (e) => {
    const {
        audioData,
        sampleRate,
        rmsThreshold,
        sampleStep,
        minSilenceDuration
    } = e.data;

    try {
        let silenceStart = null;

        for (let i = 0; i < audioData.length; i += sampleStep) {
            let sum = 0;
            for (let j = i; j < i + sampleStep && j < audioData.length; j++) {
                sum += audioData[j] * audioData[j];
            }

            const rms = Math.sqrt(sum / sampleStep);
            const currentTime = i / sampleRate;

            if (rms < rmsThreshold) {
                if (silenceStart === null) silenceStart = currentTime;
            } else {
                if (silenceStart !== null && currentTime - silenceStart >= minSilenceDuration) {
                    self.postMessage({ silentRange: [silenceStart, currentTime] });
                }
                silenceStart = null;
            }
        }

        // Catching trailing silence
        const totalDuration = audioData.length / sampleRate;
        if (silenceStart !== null && totalDuration - silenceStart >= minSilenceDuration) {
            self.postMessage({ silentRange: [silenceStart, totalDuration] });
        }

        self.postMessage({ done: true });

    } catch (err) {
        self.postMessage({ error: err.message });
    }
};