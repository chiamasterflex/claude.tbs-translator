class PCM16Worklet extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = processorOptions.targetSampleRate || 16000;
    this.frameSamples = processorOptions.frameSamples || 1600;

    this.inputSampleRate = sampleRate; // global in AudioWorklet
    this.downsampledBuffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const mono = input[0];
    const downsampled = this.downsample(mono, this.inputSampleRate, this.targetSampleRate);

    for (let i = 0; i < downsampled.length; i++) {
      this.downsampledBuffer.push(downsampled[i]);
    }

    while (this.downsampledBuffer.length >= this.frameSamples) {
      const frame = this.downsampledBuffer.splice(0, this.frameSamples);
      const pcmBuffer = this.floatTo16BitPCM(frame);

      this.port.postMessage(
        {
          type: 'pcm',
          buffer: pcmBuffer,
          bytes: pcmBuffer.byteLength
        },
        [pcmBuffer]
      );
    }

    return true;
  }

  downsample(buffer, inputRate, outputRate) {
    if (inputRate === outputRate) {
      return buffer;
    }

    if (outputRate > inputRate) {
      throw new Error('Output rate must be <= input rate');
    }

    const ratio = inputRate / outputRate;
    const newLength = Math.floor(buffer.length / ratio);
    const result = new Float32Array(newLength);

    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.floor((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }

      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }

    return result;
  }

  floatTo16BitPCM(floatArray) {
    const buffer = new ArrayBuffer(floatArray.length * 2);
    const view = new DataView(buffer);

    let offset = 0;
    for (let i = 0; i < floatArray.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, floatArray[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return buffer;
  }
}

registerProcessor('pcm16-worklet', PCM16Worklet);
