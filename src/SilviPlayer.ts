import * as MP4Box from 'mp4box';
import type { ISOFile, MP4BoxBuffer, Movie, Sample, Track } from 'mp4box';

/**
 * Configuration for SilviPlayer
 */
export interface SilviConfig {
  /** Minimum duration of silence to be skipped (in seconds). Default: 1.0 */
  minSilenceDuration?: number;
  /** RMS threshold for silence detection. Default: 0.02 */
  rmsThreshold?: number;
  /** Playback rate when fast-forwarding silent segments. Audio is reduced while skipping. Default: 4 */
  skipPlaybackRate?: number;
  /** Playback rate for normal segments. Default: 1 */
  normalPlaybackRate?: number;
  /** Volume multiplier applied while fast-forwarding silent segments. Default: 0.01 */
  skipSilenceVolume?: number;
  /** Seconds of detected silence to keep before fast-forwarding starts. Default: 0.1 */
  skipStartPaddingSeconds?: number;
  /** Seconds of detected silence to keep before fast-forwarding ends. Default: 0.1 */
  skipEndPaddingSeconds?: number;
  /** Sample rate for audio decoding (lower is faster). Default: 16000 */
  sampleRate?: number;
  /** Analysis window in seconds. Larger values are faster but less precise. Default: 0.25 */
  analysisWindow?: number;
  /** Whether to use MP4/WebCodecs audio-only analysis when supported. Default: true */
  fastAudioDecode?: boolean;
  /** Maximum file size for full decode fallback before streaming mode. Default: 100MB */
  fullDecodeMaxFileSize?: number;
  /** Chunk size used by the MP4 audio-only parser. Default: 4MB */
  fastDecodeChunkSize?: number;
  /** Whether to enable debug logging. Default: false */
  debug?: boolean;
}

export interface SilentRange {
  start: number;
  end: number;
}

type SilviBufferSource = ArrayBuffer | ArrayBufferView;

type SilviEncodedAudioChunkType = 'key' | 'delta';

interface SilviAudioDecoderConfig {
  codec: string;
  sampleRate?: number;
  numberOfChannels?: number;
  description?: SilviBufferSource;
}

interface SilviAudioDecoderInit {
  output: (audioData: SilviAudioData) => void;
  error: (error: Error) => void;
}

interface SilviEncodedAudioChunkInit {
  type: SilviEncodedAudioChunkType;
  timestamp: number;
  duration?: number;
  data: SilviBufferSource;
}

interface SilviAudioDecoder {
  readonly decodeQueueSize: number;
  readonly state: 'unconfigured' | 'configured' | 'closed';
  close(): void;
  configure(config: SilviAudioDecoderConfig): void;
  decode(chunk: SilviEncodedAudioChunk): void;
  flush(): Promise<void>;
}

interface SilviAudioDecoderConstructor {
  new(init: SilviAudioDecoderInit): SilviAudioDecoder;
}

interface SilviEncodedAudioChunk {
}

interface SilviEncodedAudioChunkConstructor {
  new(init: SilviEncodedAudioChunkInit): SilviEncodedAudioChunk;
}

interface SilviAudioData {
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly sampleRate: number;
  readonly timestamp: number;
  close(): void;
  copyTo(
    destination: SilviBufferSource,
    options: {
      planeIndex: number;
      format?: string;
      frameOffset?: number;
      frameCount?: number;
    }
  ): void;
}

type WebCodecsGlobals = typeof globalThis & {
  AudioDecoder?: SilviAudioDecoderConstructor;
  EncodedAudioChunk?: SilviEncodedAudioChunkConstructor;
};

const MEGABYTE = 1024 * 1024;
const DEFAULT_ANALYSIS_WINDOW_SECONDS = 0.25;
const DEFAULT_FULL_DECODE_MAX_FILE_SIZE = 100 * MEGABYTE;
const DEFAULT_FAST_DECODE_CHUNK_SIZE = 4 * MEGABYTE;
const MP4_METADATA_CHUNK_SIZE = 1 * MEGABYTE;
const AUDIO_RANGE_MERGE_GAP_BYTES = 4 * 1024;
const MAX_DECODE_QUEUE_SIZE = 24;
const MP4_DESCRIPTOR_DECODER_CONFIG = 4;
const MP4_DESCRIPTOR_DECODER_SPECIFIC_INFO = 5;

interface Mp4MetadataResult {
  info: Movie;
  bytesRead: number;
}

interface AudioSampleRange {
  start: number;
  end: number;
  samples: Sample[];
}

class SilenceRangeBuilder {
  public readonly ranges: SilentRange[] = [];

  private silenceStart: number | null = null;

  constructor(
    private readonly rmsThreshold: number,
    private readonly minSilenceDuration: number
  ) {}

  public addWindow(rms: number, start: number, end: number) {
    if (rms < this.rmsThreshold) {
      if (this.silenceStart === null) this.silenceStart = start;
      return;
    }

    if (this.silenceStart !== null && start - this.silenceStart >= this.minSilenceDuration) {
      this.ranges.push({ start: this.silenceStart, end: start });
    }

    this.silenceStart = null;
  }

  public finish(totalDuration: number) {
    if (this.silenceStart !== null && totalDuration - this.silenceStart >= this.minSilenceDuration) {
      this.ranges.push({ start: this.silenceStart, end: totalDuration });
    }

    this.silenceStart = null;
  }
}

class PcmWindowAnalyzer {
  private readonly rangeBuilder: SilenceRangeBuilder;
  private pendingSumSquared = 0;
  private pendingSampleCount = 0;
  private pendingWindowStart = 0;
  private lastAudioTime = 0;
  private copyBuffer = new Float32Array(0);

  constructor(
    rmsThreshold: number,
    minSilenceDuration: number,
    private readonly analysisWindow: number
  ) {
    this.rangeBuilder = new SilenceRangeBuilder(rmsThreshold, minSilenceDuration);
  }

  public get ranges() {
    return this.rangeBuilder.ranges;
  }

  public get lastTime() {
    return this.lastAudioTime;
  }

  public processAudioData(audioData: SilviAudioData) {
    const frameCount = audioData.numberOfFrames;
    if (!frameCount) return;

    if (this.copyBuffer.length < frameCount) {
      this.copyBuffer = new Float32Array(frameCount);
    }

    const samples = this.copyBuffer.subarray(0, frameCount);
    this.copyFirstChannel(audioData, samples);

    const sampleRate = audioData.sampleRate;
    const windowSamples = Math.max(1, Math.round(sampleRate * this.analysisWindow));
    const chunkStart = audioData.timestamp / 1_000_000;

    for (let i = 0; i < samples.length; i++) {
      if (this.pendingSampleCount === 0) {
        this.pendingWindowStart = chunkStart + (i / sampleRate);
      }

      this.pendingSumSquared += samples[i] * samples[i];
      this.pendingSampleCount++;

      if (this.pendingSampleCount >= windowSamples) {
        const end = chunkStart + ((i + 1) / sampleRate);
        this.flushWindow(end);
      }
    }

    this.lastAudioTime = Math.max(this.lastAudioTime, chunkStart + (frameCount / sampleRate));
  }

  public finish(totalDuration?: number) {
    if (this.pendingSampleCount > 0) {
      this.flushWindow(this.lastAudioTime);
    }

    this.rangeBuilder.finish(totalDuration ?? this.lastAudioTime);
  }

  private copyFirstChannel(audioData: SilviAudioData, target: Float32Array) {
    try {
      audioData.copyTo(target, { planeIndex: 0, format: 'f32-planar' });
    } catch {
      audioData.copyTo(target, { planeIndex: 0 });
    }
  }

  private flushWindow(end: number) {
    const rms = Math.sqrt(this.pendingSumSquared / this.pendingSampleCount);
    this.rangeBuilder.addWindow(rms, this.pendingWindowStart, end);
    this.pendingSumSquared = 0;
    this.pendingSampleCount = 0;
  }
}

export class SilviPlayer {
  private videoElement: HTMLVideoElement | null = null;
  private config: Required<SilviConfig>;
  private silentRanges: SilentRange[] = [];
  private isProcessing = false;
  private worker: Worker | null = null;
  private onStatusChange?: (status: string) => void;
  private onSkip?: (isSkipping: boolean) => void;
  private activeRangeIndex = 0;
  private isSkipping = false;
  private volumeBeforeSkip: number | null = null;
  private skipVolumeTarget: number | null = null;
  private playbackMonitorFrame: number | null = null;

  constructor(config: SilviConfig = {}) {
    this.config = {
      minSilenceDuration: config.minSilenceDuration ?? 1.0,
      rmsThreshold: config.rmsThreshold ?? 0.02,
      skipPlaybackRate: config.skipPlaybackRate ?? 4,
      normalPlaybackRate: config.normalPlaybackRate ?? 1,
      skipSilenceVolume: this.clamp(config.skipSilenceVolume ?? 0.01, 0, 1),
      skipStartPaddingSeconds: Math.max(0, config.skipStartPaddingSeconds ?? 0.1),
      skipEndPaddingSeconds: Math.max(0, config.skipEndPaddingSeconds ?? 0.1),
      sampleRate: config.sampleRate ?? 16000,
      analysisWindow: config.analysisWindow ?? DEFAULT_ANALYSIS_WINDOW_SECONDS,
      fastAudioDecode: config.fastAudioDecode ?? true,
      fullDecodeMaxFileSize: config.fullDecodeMaxFileSize ?? DEFAULT_FULL_DECODE_MAX_FILE_SIZE,
      fastDecodeChunkSize: config.fastDecodeChunkSize ?? DEFAULT_FAST_DECODE_CHUNK_SIZE,
      debug: config.debug ?? false,
    };
  }

  /**
   * Attach the SilviPlayer to a video element
   */
  public attach(video: HTMLVideoElement, options?: { 
    onStatusChange?: (status: string) => void,
    onSkip?: (isSkipping: boolean) => void 
  }) {
    this.videoElement = video;
    this.onStatusChange = options?.onStatusChange;
    this.onSkip = options?.onSkip;

    this.videoElement.addEventListener('timeupdate', this.handlePlaybackTick);
    this.videoElement.addEventListener('play', this.handlePlaybackStarted);
    this.videoElement.addEventListener('pause', this.handlePlaybackStopped);
    this.videoElement.addEventListener('ended', this.handlePlaybackStopped);
    this.videoElement.addEventListener('seeking', this.handlePlaybackTick);
    this.videoElement.addEventListener('seeked', this.handlePlaybackTick);

    if (!this.videoElement.paused && !this.videoElement.ended) {
      this.startPlaybackMonitor();
    }

    this.log('Attached to video element');
  }

  /**
   * Detach and cleanup
   */
  public detach() {
    if (this.videoElement) {
      this.videoElement.removeEventListener('timeupdate', this.handlePlaybackTick);
      this.videoElement.removeEventListener('play', this.handlePlaybackStarted);
      this.videoElement.removeEventListener('pause', this.handlePlaybackStopped);
      this.videoElement.removeEventListener('ended', this.handlePlaybackStopped);
      this.videoElement.removeEventListener('seeking', this.handlePlaybackTick);
      this.videoElement.removeEventListener('seeked', this.handlePlaybackTick);
      this.stopPlaybackMonitor();
      this.exitSkipMode();
    }
    this.terminateWorker();
    this.videoElement = null;
  }

  /**
   * Process a video file to detect silent ranges
   */
  public async processFile(file: File) {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.resetDetectedRanges();
    this.exitSkipMode();

    try {
      if (this.config.fastAudioDecode && this.canUseMp4AudioOnlyPipeline(file)) {
        try {
          await this.processFileMp4AudioOnly(file);
          return;
        } catch (error: any) {
          this.log(`Fast audio-only analysis failed: ${error.message}. Falling back...`);
        }
      }

      if (file.size > this.config.fullDecodeMaxFileSize) {
        this.log(`Large file detected (${(file.size / MEGABYTE).toFixed(2)}MB). Using streaming mode.`);
        await this.processFileStreaming(file);
        return;
      }

      await this.processFileFullDecode(file);
    } catch (error: any) {
      this.isProcessing = false;
      this.resetDetectedRanges();
      this.exitSkipMode();
      this.updateStatus(`Error: ${error.message}`);
      throw error;
    }
  }

  private async processFileFullDecode(file: File) {
    this.updateStatus('Decoding Audio...');

    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: this.config.sampleRate
      });

      const decodedBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const audioData = decodedBuffer.getChannelData(0);

      this.log(`Audio Decoded: ${decodedBuffer.duration.toFixed(2)}s, ${audioData.length} samples`);
      this.updateStatus('Analyzing Audio... playback can start');

      this.initWorker();
      this.worker!.postMessage({
        audioData,
        sampleRate: decodedBuffer.sampleRate,
        rmsThreshold: this.config.rmsThreshold,
        sampleStep: this.getAnalysisSampleStep(decodedBuffer.sampleRate),
        minSilenceDuration: this.config.minSilenceDuration
      }, [audioData.buffer]);

      audioCtx.close();
    } catch (error: any) {
      this.log(`Standard decoding failed: ${error.message}. Attempting streaming fallback...`);
      return this.processFileStreaming(file);
    }
  }

  /**
   * Fast path for MP4/MOV files: demux only the audio track and decode it with
   * WebCodecs in chunks, avoiding full video decode and full-file PCM buffers.
   */
  private async processFileMp4AudioOnly(file: File) {
    try {
      await this.processFileMp4AudioRanges(file);
    } catch (error: any) {
      this.log(`Audio byte-range analysis failed: ${error.message}. Falling back to MP4Box extraction...`);
      this.resetDetectedRanges();
      this.exitSkipMode();
      await this.processFileMp4AudioOnlySequential(file);
    }
  }

  /**
   * Faster MP4/MOV path: parse MP4 metadata, then read only the byte ranges that
   * contain encoded audio samples. This avoids scanning the full video payload.
   */
  private async processFileMp4AudioRanges(file: File) {
    const codecs = this.getWebCodecsGlobals();
    if (!codecs.AudioDecoder || !codecs.EncodedAudioChunk) {
      throw new Error('WebCodecs audio decoding is not available');
    }
    const decoderCtor = codecs.AudioDecoder as SilviAudioDecoderConstructor;
    const chunkCtor = codecs.EncodedAudioChunk as SilviEncodedAudioChunkConstructor;

    this.updateStatus('Analyzing audio track... playback can start');

    const mp4boxfile = MP4Box.createFile() as ISOFile<unknown, unknown>;
    const analyzer = new PcmWindowAnalyzer(
      this.config.rmsThreshold,
      this.config.minSilenceDuration,
      this.config.analysisWindow
    );
    this.publishProgressiveRanges(analyzer.ranges);

    let audioTrack: Track | null = null;
    let decoder: SilviAudioDecoder | null = null;
    let decoderConfig: SilviAudioDecoderConfig | null = null;
    let decoderError: Error | null = null;
    let lastProgressUpdate = 0;

    try {
      const metadata = await this.readMp4Metadata(file, mp4boxfile);

      if (metadata.info.isFragmented) {
        throw new Error('Fragmented MP4 needs sequential extraction');
      }

      audioTrack = this.pickAudioTrack(metadata.info);
      if (!audioTrack) {
        throw new Error('No audio track found');
      }

      const samples = this.getMp4TrackSamples(mp4boxfile, audioTrack.id);
      if (!samples.length) {
        throw new Error('No audio samples found');
      }

      if (!this.canReadSamplesByByteRange(samples)) {
        throw new Error('Audio sample byte ranges are not monotonic');
      }

      const ranges = this.buildAudioSampleRanges(samples);
      let bytesRead = metadata.bytesRead;

      for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
        if (decoderError) throw decoderError;

        const range = ranges[rangeIndex];
        const buffer = await file.slice(range.start, range.end).arrayBuffer();
        bytesRead += buffer.byteLength;
        const rangeBytes = new Uint8Array(buffer);

        for (const sample of range.samples) {
          if (decoderError) throw decoderError;

          if (!decoder) {
            const config = this.createAudioDecoderConfig(audioTrack, sample);
            decoder = new decoderCtor({
              output: (audioData) => {
                analyzer.processAudioData(audioData);
                audioData.close();

                const now = performance.now();
                if (now - lastProgressUpdate > 1000) {
                  this.updateAudioOnlyProgress(audioTrack!, analyzer.lastTime);
                  lastProgressUpdate = now;
                }
              },
              error: (error) => {
                decoderError = error;
              },
            });
            decoder.configure(config);
            decoderConfig = config;
          }

          const sampleOffset = sample.offset - range.start;
          const sampleData = rangeBytes.subarray(sampleOffset, sampleOffset + sample.size);

          await this.waitForDecodeQueue(decoder);
          decoder.decode(new chunkCtor({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: this.sampleTimeToMicroseconds(sample.cts, sample.timescale),
            duration: this.sampleTimeToMicroseconds(sample.duration, sample.timescale, 1),
            data: sampleData,
          }));
        }

        if (rangeIndex % 32 === 0) {
          await this.yieldToEventLoop();
        }
      }

      if (!decoder) {
        throw new Error('No decodable audio samples found');
      }

      await decoder.flush();
      if (decoderError) throw decoderError;

      const trackDuration = audioTrack.duration / audioTrack.timescale;
      analyzer.finish(trackDuration);
      this.isProcessing = false;
      this.updateStatus('Ready');
      this.log(
        `Audio byte-range analysis complete using ${decoderConfig?.codec ?? 'unknown codec'}. ` +
        `Read ${(bytesRead / MEGABYTE).toFixed(2)}MB of ${(file.size / MEGABYTE).toFixed(2)}MB. ` +
        `Found ${this.silentRanges.length} silent ranges.`
      );
    } finally {
      try {
        decoder?.close();
      } catch {
        // Decoder may already be closed after an async error.
      }
      mp4boxfile.stop();
    }
  }

  /**
   * Safe fallback: let MP4Box request sample bytes as it parses. This can read
   * more media data than the byte-range path but handles more MP4 variants.
   */
  private async processFileMp4AudioOnlySequential(file: File) {
    const codecs = this.getWebCodecsGlobals();
    if (!codecs.AudioDecoder || !codecs.EncodedAudioChunk) {
      throw new Error('WebCodecs audio decoding is not available');
    }

    this.updateStatus('Analyzing audio track... playback can start');

    const mp4boxfile = MP4Box.createFile() as ISOFile<unknown, unknown>;
    const analyzer = new PcmWindowAnalyzer(
      this.config.rmsThreshold,
      this.config.minSilenceDuration,
      this.config.analysisWindow
    );
    this.publishProgressiveRanges(analyzer.ranges);

    let audioTrack: Track | null = null;
    let decoder: SilviAudioDecoder | null = null;
    let decoderConfig: SilviAudioDecoderConfig | null = null;
    let decodePump = Promise.resolve();
    let decoderError: Error | null = null;
    let lastProgressUpdate = 0;
    let mp4Error: Error | null = null;
    let metadataReady = false;

    mp4boxfile.onError = (_module, message) => {
      mp4Error = new Error(message);
    };

    mp4boxfile.onReady = (info: Movie) => {
      metadataReady = true;
      audioTrack = this.pickAudioTrack(info);
      if (!audioTrack) {
        mp4Error = new Error('No audio track found');
        return;
      }

      mp4boxfile.onSamples = (_id, _user, samples) => {
        decodePump = decodePump.then(() => this.decodeMp4Samples({
          samples,
          track: audioTrack!,
          mp4boxfile,
          decoderCtor: codecs.AudioDecoder!,
          chunkCtor: codecs.EncodedAudioChunk!,
          getDecoder: () => decoder,
          setDecoder: (nextDecoder, config) => {
            decoder = nextDecoder;
            decoderConfig = config;
          },
          setDecoderError: (error) => {
            decoderError = error;
          },
          onAudioData: (audioData) => {
            analyzer.processAudioData(audioData);
            audioData.close();

            const now = performance.now();
            if (now - lastProgressUpdate > 1000) {
              this.updateAudioOnlyProgress(audioTrack!, analyzer.lastTime);
              lastProgressUpdate = now;
            }
          },
        }));
      };

      mp4boxfile.setExtractionOptions(audioTrack.id, undefined, { nbSamples: 200 });
      mp4boxfile.start();
    };

    try {
      await this.feedMp4File(file, mp4boxfile);
      if (mp4Error) throw mp4Error;
      if (!metadataReady) throw new Error('MP4 metadata was not found');

      await decodePump;
      if (decoderError) throw decoderError;

      if (!decoder) {
        throw new Error('No decodable audio samples found');
      }

      await decoder.flush();
      if (decoderError) throw decoderError;

      const trackDuration = audioTrack
        ? audioTrack.duration / audioTrack.timescale
        : analyzer.lastTime;

      analyzer.finish(trackDuration);
      this.isProcessing = false;
      this.updateStatus('Ready');
      this.log(
        `Sequential MP4 audio analysis complete using ${decoderConfig?.codec ?? 'unknown codec'}. ` +
        `Found ${this.silentRanges.length} silent ranges.`
      );
    } finally {
      try {
        decoder?.close();
      } catch {
        // Decoder may already be closed after an async error.
      }
      mp4boxfile.stop();
    }
  }

  private async readMp4Metadata(file: File, mp4boxfile: ISOFile<unknown, unknown>): Promise<Mp4MetadataResult> {
    let metadata: Movie | null = null;
    let mp4Error: Error | null = null;
    let offset = 0;
    let bytesRead = 0;

    mp4boxfile.onReady = (info: Movie) => {
      metadata = info;
    };

    mp4boxfile.onError = (_module, message) => {
      mp4Error = new Error(message);
    };

    while (!metadata && offset < file.size) {
      const chunkSize = Math.min(this.config.fastDecodeChunkSize, MP4_METADATA_CHUNK_SIZE);
      const end = Math.min(offset + chunkSize, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer() as MP4BoxBuffer;
      buffer.fileStart = offset;
      bytesRead += buffer.byteLength;

      const nextOffset = mp4boxfile.appendBuffer(buffer, end >= file.size);
      if (mp4Error) throw mp4Error;
      if (metadata) break;

      if (typeof nextOffset === 'number' && Number.isFinite(nextOffset) && nextOffset > offset) {
        offset = Math.min(nextOffset, file.size);
      } else {
        offset = end;
      }
    }

    if (mp4Error) throw mp4Error;
    if (!metadata) {
      mp4boxfile.flush();
      if (mp4Error) throw mp4Error;
    }

    if (!metadata) throw new Error('MP4 metadata was not found');

    return { info: metadata, bytesRead };
  }

  private getMp4TrackSamples(mp4boxfile: ISOFile<unknown, unknown>, trackId: number) {
    const samples = mp4boxfile.getTrackSamplesInfo(trackId) ?? [];
    return samples.filter(sample => sample.size > 0);
  }

  private canReadSamplesByByteRange(samples: Sample[]) {
    let previousOffset = -1;

    for (const sample of samples) {
      if (
        !Number.isFinite(sample.offset) ||
        !Number.isFinite(sample.size) ||
        sample.offset < previousOffset
      ) {
        return false;
      }

      previousOffset = sample.offset;
    }

    return true;
  }

  private buildAudioSampleRanges(samples: Sample[]) {
    const ranges: AudioSampleRange[] = [];
    const maxRangeBytes = this.config.fastDecodeChunkSize;

    for (const sample of samples) {
      const start = sample.offset;
      const end = sample.offset + sample.size;
      const current = ranges[ranges.length - 1];

      if (
        !current ||
        start > current.end + AUDIO_RANGE_MERGE_GAP_BYTES ||
        end - current.start > maxRangeBytes
      ) {
        ranges.push({ start, end, samples: [sample] });
        continue;
      }

      current.end = Math.max(current.end, end);
      current.samples.push(sample);
    }

    return ranges;
  }

  private async yieldToEventLoop() {
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  private async feedMp4File(file: File, mp4boxfile: ISOFile<unknown, unknown>) {
    let offset = 0;

    while (offset < file.size) {
      const end = Math.min(offset + this.config.fastDecodeChunkSize, file.size);
      const buffer = await file.slice(offset, end).arrayBuffer() as MP4BoxBuffer;
      buffer.fileStart = offset;

      const nextOffset = mp4boxfile.appendBuffer(buffer, end >= file.size);
      if (typeof nextOffset === 'number' && nextOffset > offset) {
        offset = nextOffset;
      } else {
        offset = end;
      }
    }

    mp4boxfile.flush();
  }

  private async decodeMp4Samples(options: {
    samples: Sample[];
    track: Track;
    mp4boxfile: ISOFile<unknown, unknown>;
    decoderCtor: SilviAudioDecoderConstructor;
    chunkCtor: SilviEncodedAudioChunkConstructor;
    getDecoder: () => SilviAudioDecoder | null;
    setDecoder: (decoder: SilviAudioDecoder, config: SilviAudioDecoderConfig) => void;
    setDecoderError: (error: Error) => void;
    onAudioData: (audioData: SilviAudioData) => void;
  }) {
    if (!options.samples.length) return;

    let lastSampleNumber = 0;

    for (const sample of options.samples) {
      if (!sample.data) continue;

      let decoder = options.getDecoder();
      if (!decoder) {
        const config = this.createAudioDecoderConfig(options.track, sample);
        decoder = new options.decoderCtor({
          output: options.onAudioData,
          error: (error) => {
            options.setDecoderError(error);
          },
        });
        decoder.configure(config);
        options.setDecoder(decoder, config);
      }

      await this.waitForDecodeQueue(decoder);
      decoder.decode(new options.chunkCtor({
        type: sample.is_sync ? 'key' : 'delta',
        timestamp: this.sampleTimeToMicroseconds(sample.cts, sample.timescale),
        duration: this.sampleTimeToMicroseconds(sample.duration, sample.timescale, 1),
        data: sample.data,
      }));

      lastSampleNumber = sample.number;
    }

    if (lastSampleNumber > 0) {
      options.mp4boxfile.releaseUsedSamples(options.track.id, lastSampleNumber);
    }
  }

  private createAudioDecoderConfig(track: Track, sample: Sample): SilviAudioDecoderConfig {
    const config: SilviAudioDecoderConfig = {
      codec: this.normalizeAudioCodec(track.codec),
      sampleRate: track.audio?.sample_rate ?? this.config.sampleRate,
      numberOfChannels: track.audio?.channel_count ?? 2,
    };

    const description = this.extractDecoderSpecificInfo(sample.description);
    if (description) {
      config.description = description;
    }

    return config;
  }

  private extractDecoderSpecificInfo(description: Sample['description']) {
    const esd = (description as any)?.esds?.esd;
    const decoderConfig = esd?.findDescriptor?.(MP4_DESCRIPTOR_DECODER_CONFIG);
    const specificInfo = decoderConfig?.findDescriptor?.(MP4_DESCRIPTOR_DECODER_SPECIFIC_INFO);
    const data = specificInfo?.data;

    if (!data) return undefined;
    return data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
  }

  private pickAudioTrack(info: Movie) {
    return info.audioTracks[0] ?? info.tracks.find(track => track.type === 'audio' || track.audio);
  }

  private normalizeAudioCodec(codec: string) {
    return codec === 'Opus' ? 'opus' : codec;
  }

  private sampleTimeToMicroseconds(value: number, timescale: number, minValue = 0) {
    return Math.max(minValue, Math.round((value / timescale) * 1_000_000));
  }

  private async waitForDecodeQueue(decoder: SilviAudioDecoder) {
    while (decoder.state !== 'closed' && decoder.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  private updateAudioOnlyProgress(track: Track, analyzedSeconds: number) {
    const duration = track.duration / track.timescale;
    if (!duration) return;

    const progress = Math.min(99, Math.floor((analyzedSeconds / duration) * 100));
    this.updateStatus(`Analyzing Audio: ${progress}%`);
  }

  private canUseMp4AudioOnlyPipeline(file: File) {
    const codecs = this.getWebCodecsGlobals();
    if (!codecs.AudioDecoder || !codecs.EncodedAudioChunk) return false;

    const mimeType = file.type.toLowerCase();
    return (
      mimeType.includes('mp4') ||
      mimeType.includes('quicktime') ||
      /\.(mp4|m4v|mov)$/i.test(file.name)
    );
  }

  private getWebCodecsGlobals() {
    return globalThis as WebCodecsGlobals;
  }

  private getAnalysisSampleStep(sampleRate: number) {
    return Math.max(1, Math.round(sampleRate * this.config.analysisWindow));
  }

  /**
   * Streaming fallback for large files or when decodeAudioData fails.
   * Uses a hidden video element to process audio at high playback speed.
   */
  private async processFileStreaming(file: File) {
    this.updateStatus('Decoding Audio (Streaming Mode)... playback can start');
    
    return new Promise<void>((resolve, reject) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.muted = false;
      video.volume = 0;
      video.playbackRate = 8;
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Attempt to resume context if it's suspended
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }

      let source: MediaElementAudioSourceNode;
      try {
        source = audioCtx.createMediaElementSource(video);
      } catch (err) {
        // Some browsers might fail if not in DOM, though rare
        this.log('MediaElementSource failed, attempting DOM attach');
        video.style.display = 'none';
        document.body.appendChild(video);
        source = audioCtx.createMediaElementSource(video);
      }

      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      silentGain.connect(audioCtx.destination);

      const rangeBuilder = new SilenceRangeBuilder(this.config.rmsThreshold, this.config.minSilenceDuration);
      this.publishProgressiveRanges(rangeBuilder.ranges);
      let lastProgressUpdate = 0;
      let nonSilentSamples = 0;
      let lastAnalyzedTime = 0;

      const handleAudioProcess = (rms: number, currentTime: number) => {
        if (rms > 0.0001) nonSilentSamples++;

        const windowStart = Math.min(lastAnalyzedTime, currentTime);
        rangeBuilder.addWindow(rms, windowStart, currentTime);
        lastAnalyzedTime = currentTime;

        // Update progress every 2 seconds of real time
        const now = performance.now();
        if (now - lastProgressUpdate > 2000 && video.duration) {
          const progress = Math.floor((video.currentTime / video.duration) * 100);
          this.updateStatus(`Decoding Audio: ${progress}%`);
          lastProgressUpdate = now;
        }
      };

      const setupScriptProcessor = () => {
        const bufferSize = this.getScriptProcessorBufferSize(audioCtx.sampleRate);
        const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < input.length; i++) {
            sum += input[i] * input[i];
          }
          const rms = Math.sqrt(sum / input.length);
          handleAudioProcess(rms, video.currentTime);
        };
        source.connect(processor);
        processor.connect(silentGain);
      };

      if (audioCtx.audioWorklet) {
        const processorCode = `
          class SilenceProcessor extends AudioWorkletProcessor {
            constructor(options) {
              super();
              this.bufferSize = options.processorOptions.bufferSize;
              this.currentBufferSamples = 0;
              this.sumSquared = 0;
            }
            process(inputs) {
              const input = inputs[0];
              if (!input || !input[0]) return true;
              const channelData = input[0];
              const length = channelData.length;
              for (let i = 0; i < length; i++) {
                this.sumSquared += channelData[i] * channelData[i];
              }
              this.currentBufferSamples += length;
              if (this.currentBufferSamples >= this.bufferSize) {
                const rms = Math.sqrt(this.sumSquared / this.currentBufferSamples);
                this.port.postMessage({ type: 'rms', rms });
                this.sumSquared = 0;
                this.currentBufferSamples = 0;
              }
              return true;
            }
          }
          registerProcessor('silence-processor', SilenceProcessor);
        `;
        const blob = new Blob([processorCode], { type: 'application/javascript' });
        const processorUrl = URL.createObjectURL(blob);

        audioCtx.audioWorklet.addModule(processorUrl).then(() => {
          const processor = new AudioWorkletNode(audioCtx, 'silence-processor', {
            processorOptions: {
              bufferSize: this.getAnalysisSampleStep(audioCtx.sampleRate),
            },
          });
          processor.port.onmessage = (e) => {
            if (e.data.type === 'rms') {
              handleAudioProcess(e.data.rms, video.currentTime);
            }
          };
          source.connect(processor);
          processor.connect(silentGain);
          URL.revokeObjectURL(processorUrl);
        }).catch((err) => {
          this.log('AudioWorklet failed, falling back to ScriptProcessor');
          setupScriptProcessor();
        });
      } else {
        setupScriptProcessor();
      }
      
      video.onended = () => {
        rangeBuilder.finish(video.duration);
        const detectedSomeAudio = nonSilentSamples > 0;
        const firstRange = rangeBuilder.ranges[0];
        const isEntireVideoSilent = (
          rangeBuilder.ranges.length === 1 &&
          firstRange &&
          (firstRange.end - firstRange.start) / video.duration > 0.99
        );

        if (!isEntireVideoSilent || detectedSomeAudio) {
          this.publishProgressiveRanges(rangeBuilder.ranges);
        } else {
          this.resetDetectedRanges();
          this.log('Detection failed: No audio detected during streaming.');
        }

        this.isProcessing = false;
        this.updateStatus('Ready');
        audioCtx.close();
        URL.revokeObjectURL(video.src);
        if (video.parentElement) video.parentElement.removeChild(video);
        this.log(`Streaming complete. Found ${this.silentRanges.length} silent ranges.`);
        resolve();
      };
      
      video.onerror = () => {
        this.isProcessing = false;
        const msg = video.error ? video.error.message : 'Unknown video error';
        this.updateStatus(`Error: ${msg}`);
        audioCtx.close();
        URL.revokeObjectURL(video.src);
        if (video.parentElement) video.parentElement.removeChild(video);
        reject(new Error(msg));
      };
      
      video.onloadedmetadata = () => {
        video.play().catch(err => {
          this.isProcessing = false;
          this.updateStatus(`Error: ${err.message}`);
          reject(err);
        });
      };
    });
  }

  private initWorker() {
    this.terminateWorker();
    
    // Inline worker keeps fallback analysis portable across bundlers.
    const workerCode = `
      self.onmessage = (e) => {
        const { audioData, sampleRate, rmsThreshold, sampleStep, minSilenceDuration } = e.data;
        try {
          let silenceStart = null;
          for (let i = 0; i < audioData.length; i += sampleStep) {
            let sum = 0;
            for (let j = i; j < i + sampleStep && j < audioData.length; j++) {
              sum += audioData[j] * audioData[j];
            }
            const count = Math.min(sampleStep, audioData.length - i);
            const rms = Math.sqrt(sum / count);
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
          const totalDuration = audioData.length / sampleRate;
          if (silenceStart !== null && totalDuration - silenceStart >= minSilenceDuration) {
            self.postMessage({ silentRange: [silenceStart, totalDuration] });
          }
          self.postMessage({ done: true });
        } catch (err) {
          self.postMessage({ error: err.message });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: 'application/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob));

    this.worker.onmessage = (e) => {
      const { silentRange, done, error } = e.data;

      if (error) {
        this.updateStatus(`Worker Error: ${error}`);
        this.isProcessing = false;
        this.resetDetectedRanges();
        this.exitSkipMode();
        return;
      }

      if (silentRange) {
        this.silentRanges.push({ start: silentRange[0], end: silentRange[1] });
      }

      if (done) {
        this.isProcessing = false;
        this.updateStatus('Ready');
        this.log(`Processing complete. Found ${this.silentRanges.length} silent ranges.`);
      }
    };
  }

  private terminateWorker() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  private handlePlaybackTick = () => {
    if (!this.videoElement) return;

    if (this.videoElement.paused || this.videoElement.ended) {
      this.exitSkipMode();
      return;
    }

    const currentTime = this.videoElement.currentTime;
    const isSilent = !!this.getCurrentSkippableRange(currentTime);

    if (isSilent) {
      this.enterSkipMode();
      return;
    }

    this.exitSkipMode();
  }

  private resetDetectedRanges() {
    this.silentRanges = [];
    this.activeRangeIndex = 0;
  }

  private publishProgressiveRanges(ranges: SilentRange[]) {
    this.silentRanges = ranges;
    this.activeRangeIndex = 0;
  }

  private handlePlaybackStarted = () => {
    this.startPlaybackMonitor();
    this.handlePlaybackTick();
  }

  private handlePlaybackStopped = () => {
    this.stopPlaybackMonitor();
    this.exitSkipMode();
  }

  private startPlaybackMonitor() {
    if (this.playbackMonitorFrame !== null || typeof requestAnimationFrame === 'undefined') {
      return;
    }

    const tick = () => {
      this.playbackMonitorFrame = null;
      this.handlePlaybackTick();

      if (this.videoElement && !this.videoElement.paused && !this.videoElement.ended) {
        this.playbackMonitorFrame = requestAnimationFrame(tick);
      }
    };

    this.playbackMonitorFrame = requestAnimationFrame(tick);
  }

  private stopPlaybackMonitor() {
    if (this.playbackMonitorFrame === null || typeof cancelAnimationFrame === 'undefined') {
      this.playbackMonitorFrame = null;
      return;
    }

    cancelAnimationFrame(this.playbackMonitorFrame);
    this.playbackMonitorFrame = null;
  }

  private enterSkipMode() {
    if (!this.videoElement) return;

    this.setPlaybackRate(this.config.skipPlaybackRate);

    if (this.isSkipping) {
      return;
    }

    this.volumeBeforeSkip = this.videoElement.volume;
    this.skipVolumeTarget = this.getSkipVolumeTarget(this.volumeBeforeSkip);
    this.videoElement.volume = this.skipVolumeTarget;
    this.setSkipping(true);
  }

  private exitSkipMode() {
    if (this.videoElement) {
      this.setPlaybackRate(this.config.normalPlaybackRate);

      if (
        this.volumeBeforeSkip !== null &&
        this.skipVolumeTarget !== null &&
        Math.abs(this.videoElement.volume - this.skipVolumeTarget) < 0.001
      ) {
        this.videoElement.volume = this.volumeBeforeSkip;
      }
    }

    this.volumeBeforeSkip = null;
    this.skipVolumeTarget = null;
    this.setSkipping(false);
  }

  private getCurrentSkippableRange(currentTime: number) {
    const range = this.getCurrentSilentRange(currentTime);
    if (!range) return null;

    const effectiveStart = Math.min(
      range.end,
      range.start + this.config.skipStartPaddingSeconds
    );
    const effectiveEnd = Math.max(
      effectiveStart,
      range.end - this.config.skipEndPaddingSeconds
    );

    return currentTime >= effectiveStart && currentTime < effectiveEnd ? range : null;
  }

  private getCurrentSilentRange(currentTime: number) {
    if (!this.silentRanges.length) return null;

    const activeRange = this.silentRanges[this.activeRangeIndex];
    if (activeRange && currentTime >= activeRange.start && currentTime < activeRange.end) {
      return activeRange;
    }

    const rangeIndex = this.findSilentRangeIndex(currentTime);
    if (rangeIndex === -1) return null;

    this.activeRangeIndex = rangeIndex;
    return this.silentRanges[rangeIndex];
  }

  private findSilentRangeIndex(currentTime: number) {
    let low = 0;
    let high = this.silentRanges.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const range = this.silentRanges[mid];

      if (currentTime < range.start) {
        high = mid - 1;
      } else if (currentTime >= range.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }

    return -1;
  }

  private getSkipVolumeTarget(baseVolume: number) {
    return this.clamp(baseVolume * this.config.skipSilenceVolume, 0, 1);
  }

  private setPlaybackRate(playbackRate: number) {
    if (this.videoElement && this.videoElement.playbackRate !== playbackRate) {
      this.videoElement.playbackRate = playbackRate;
    }
  }

  private clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
  }

  private setSkipping(isSkipping: boolean) {
    if (this.isSkipping === isSkipping) return;

    this.isSkipping = isSkipping;
    this.onSkip?.(isSkipping);
  }

  private getScriptProcessorBufferSize(sampleRate: number) {
    const desired = this.getAnalysisSampleStep(sampleRate);
    const sizes = [1024, 2048, 4096, 8192, 16384, 32768];
    return sizes.find(size => size >= desired) ?? sizes[sizes.length - 1];
  }

  private updateStatus(status: string) {
    this.onStatusChange?.(status);
    this.log(`Status: ${status}`);
  }

  private log(message: string) {
    if (this.config.debug) {
      console.log(`[SilviPlayer] ${message}`);
    }
  }
}
