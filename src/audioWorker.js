// /audioWorker.js
self.onmessage = (e) => {
    const {
        chunkIndex,
        chunkData,
        sampleRate,
        startTime,
        endTime,
        rmsThreshold,
        sampleStep,
        minSilenceDuration
    } = e.data;

    try {
        let silenceStart = null;
        const detectedRanges = [];

        for (let i = 0; i < chunkData.length; i += sampleStep) {
            let sum = 0;
            for (let j = i; j < i + sampleStep && j < chunkData.length; j++) {
                sum += chunkData[j] * chunkData[j];
            }

            const rms = Math.sqrt(sum / sampleStep);
            const currentTime = startTime + i / sampleRate;

            if (rms < rmsThreshold) {
                if (silenceStart === null) silenceStart = currentTime;
            } else {
                if (silenceStart !== null && currentTime - silenceStart >= minSilenceDuration) {
                    detectedRanges.push([silenceStart, currentTime]);
                }
                silenceStart = null;
            }
        }

        if (silenceStart !== null && endTime - silenceStart >= minSilenceDuration) {
            detectedRanges.push([silenceStart, endTime]);
        }

        self.postMessage({ chunkIndex, silentRanges: detectedRanges });
    } catch (err) {
        self.postMessage({ chunkIndex, error: err.message });
    }
};
