/**
 * WASM 音频处理器 - JavaScript 封装层
 * 用于替换 ivc.html 中的流式音频处理函数
 */

class WASMAudioProcessor {
    constructor() {
        this.wasmModule = null;
        this.wasmMemory = null;
        this.initialized = false;
    }

    /**
     * 初始化WASM模块
     * @param {ArrayBuffer} wasmBinary - WASM二进制数据
     */
    async initialize(wasmBinary) {
        try {
            // 创建WASM内存
            const pageSize = 64 * 1024; // 64KB页
            const initialPages = 256;   // 16MB初始内存
            this.wasmMemory = new WebAssembly.Memory({
                initial: initialPages,
                maximum: 1024 // 最大64MB
            });

            // 创建导入对象
            const importObject = {
                env: {
                    memory: this.wasmMemory,
                    // 可以添加其他导入函数
                }
            };

            // 加载WASM模块
            const module = await WebAssembly.instantiate(wasmBinary, importObject);
            this.wasmModule = module.instance.exports;

            // 初始化WASM内存
            const initResult = this.wasmModule.wasm_init_memory(16 * 1024 * 1024); // 16MB
            if (initResult === 0) {
                throw new Error('WASM内存初始化失败');
            }

            this.initialized = true;
            console.log('WASM音频处理器初始化成功');
            return true;

        } catch (error) {
            console.error('WASM初始化失败:', error);
            throw error;
        }
    }

    /**
     * 检查是否已初始化
     */
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('WASM模块未初始化，请先调用 initialize()');
        }
    }

    /**
     * AudioBuffer转WAV Blob
     * @param {AudioBuffer} audioBuffer - Web Audio API的AudioBuffer对象
     * @param {number} [bitsPerSample=16] - 位深 (16 或 24)
     * @returns {Promise<Blob>} WAV格式的Blob
     */
    async audioBufferToWav(audioBuffer, bitsPerSample = 16) {
        this.ensureInitialized();

        // 获取AudioBuffer数据
        const numberOfChannels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const sampleRate = audioBuffer.sampleRate;

        // 合并所有声道数据为交错的浮点数组
        const interleavedData = new Float32Array(length * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                interleavedData[i * numberOfChannels + channel] = channelData[i];
            }
        }

        // 将数据复制到WASM内存
        const wasmMemory = this.wasmMemory.buffer;
        const wasmHeap = new Uint8Array(wasmMemory);

        // 找到足够大的内存位置
        const dataSize = interleavedData.length * 4; // 4 bytes per float
        const wasmOffset = 0; // 假设从内存起始处开始

        const wasmFloatView = new Float32Array(wasmMemory);
        wasmFloatView.set(interleavedData, wasmOffset / 4);

        // 调用WASM函数转换
        const resultSize = this.wasmModule.wasm_audio_buffer_to_wav(
            wasmOffset,
            length,
            numberOfChannels,
            sampleRate,
            bitsPerSample
        );

        if (resultSize === 0) {
            throw new Error('WASM WAV转换失败');
        }

        // 从WASM内存提取结果
        const wavData = wasmHeap.slice(0, resultSize);

        return new Blob([wavData], { type: 'audio/wav' });
    }

    /**
     * WAV转AudioBuffer
     * @param {ArrayBuffer} wavArrayBuffer - WAV文件的ArrayBuffer
     * @param {AudioContext} audioContext - Web Audio API的AudioContext
     * @returns {Promise<AudioBuffer>} 解码后的AudioBuffer
     */
    async wavToAudioBuffer(wavArrayBuffer, audioContext) {
        this.ensureInitialized();

        // 将WAV数据复制到WASM内存
        const wasmHeap = new Uint8Array(this.wasmMemory.buffer);
        const dataSize = wavArrayBuffer.byteLength;

        // 检查内存是否足够
        if (dataSize > wasmHeap.length) {
            throw new Error('WASM内存不足，无法处理此WAV文件');
        }

        wasmHeap.set(new Uint8Array(wavArrayBuffer), 0);

        // 创建AudioBuffer结构体 (简化版本)
        // 注意: 这里需要根据实际的C结构体布局进行调整
        const audioBufferPtr = 0; // 假设在内存起始位置存储结果

        // 调用WASM函数解码
        const numSamples = this.wasmModule.wasm_wav_to_audio_buffer(
            0, // WAV数据在WASM内存中的偏移
            dataSize
        );

        if (numSamples === 0) {
            throw new Error('WAV解码失败');
        }

        // 从WASM内存提取解码后的数据
        // 注意: 需要访问WASM内存中的AudioBuffer结构体来获取参数
        // 这里假设我们知道采样率和声道数 (实际应用中需要从WASM读取)

        // 获取解码后的浮点数据
        const bufferSize = this.wasmModule.wasm_get_buffer_size();
        const decodedData = new Float32Array(
            this.wasmMemory.buffer.slice(0, bufferSize)
        );

        // 注意: 这里需要从WASM获取正确的参数
        // 实际实现中需要添加WASM函数来获取这些值
        const sampleRate = 24000; // 需要从WASM获取
        const numberOfChannels = 1; // 需要从WASM获取

        // 创建Web Audio API的AudioBuffer
        const audioBuffer = audioContext.createBuffer(
            numberOfChannels,
            numSamples,
            sampleRate
        );

        // 将交错的数据分离到各个声道
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < numSamples; i++) {
                channelData[i] = decodedData[i * numberOfChannels + channel];
            }
        }

        return audioBuffer;
    }

    /**
     * 切分AudioBuffer为多个片段
     * @param {AudioBuffer} audioBuffer - 源AudioBuffer
     * @param {number} segmentDurationSeconds - 每个片段的时长(秒)
     * @param {AudioContext} audioContext - Web Audio API的AudioContext
     * @returns {Promise<Blob[]>} WAV格式的片段数组
     */
    async splitAudioIntoSegments(audioBuffer, segmentDurationSeconds, audioContext) {
        this.ensureInitialized();

        const sampleRate = audioBuffer.sampleRate;
        const samplesPerSegment = Math.floor(segmentDurationSeconds * sampleRate);
        const totalSamples = audioBuffer.length;
        const numSegments = Math.ceil(totalSamples / samplesPerSegment);
        const numberOfChannels = audioBuffer.numberOfChannels;

        console.log(`音频总时长: ${(totalSamples / sampleRate).toFixed(2)}秒`);
        console.log(`将切分为 ${numSegments} 个片段，每个 ${segmentDurationSeconds} 秒`);

        const segments = [];

        // 合并所有声道数据为交错的浮点数组
        const interleavedData = new Float32Array(totalSamples * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < totalSamples; i++) {
                interleavedData[i * numberOfChannels + channel] = channelData[i];
            }
        }

        // 复制到WASM内存
        const wasmFloatView = new Float32Array(this.wasmMemory.buffer);
        const sourceOffset = 0;
        wasmFloatView.set(interleavedData, sourceOffset / 4);

        // 切分每个片段
        for (let i = 0; i < numSegments; i++) {
            const startSample = i * samplesPerSegment;
            const endSample = Math.min((i + 1) * samplesPerSegment, totalSamples);
            const sliceLength = endSample - startSample;

            // 调用WASM切片函数
            const sliceResult = this.wasmModule.wasm_slice_audio(
                sourceOffset, // 需要传递AudioBuffer结构体
                startSample,
                sliceLength
            );

            if (sliceResult === 0) {
                console.warn(`片段 ${i + 1} 切片失败`);
                continue;
            }

            // 从WASM内存提取切片数据
            const sliceBufferSize = this.wasmModule.wasm_get_buffer_size();
            const sliceData = new Float32Array(
                this.wasmMemory.buffer.slice(0, sliceBufferSize)
            );

            // 创建临时AudioBuffer
            const segmentBuffer = audioContext.createBuffer(
                numberOfChannels,
                sliceLength,
                sampleRate
            );

            // 将交错的数据分离到各个声道
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const channelData = segmentBuffer.getChannelData(channel);
                for (let j = 0; j < sliceLength; j++) {
                    channelData[j] = sliceData[j * numberOfChannels + channel];
                }
            }

            // 转换为WAV Blob
            const wavBlob = await this.audioBufferToWav(segmentBuffer);
            const base64 = await this.blobToBase64(wavBlob);

            segments.push({
                index: i,
                base64: base64,
                duration: sliceLength / sampleRate,
                startTime: startSample / sampleRate,
                endTime: endSample / sampleRate
            });
        }

        return {
            segments: segments,
            totalDuration: totalSamples / sampleRate,
            sampleRate: sampleRate,
            numSegments: numSegments
        };
    }

    /**
     * 合并多个音频片段
     * @param {Blob[]} wavBlobs - WAV格式的片段数组
     * @param {AudioContext} audioContext - Web Audio API的AudioContext
     * @returns {Promise<Blob>} 合并后的WAV Blob
     */
    async mergeAudioSegments(wavBlobs, audioContext) {
        this.ensureInitialized();

        // 先解码所有WAV片段
        const audioBuffers = await Promise.all(
            wavBlobs.map(blob => audioContext.decodeAudioData(
                blob.arrayBuffer ? blob.arrayBuffer() : this.blobToArrayBuffer(blob)
            ))
        );

        if (audioBuffers.length === 0) {
            throw new Error('没有可合并的音频片段');
        }

        const numberOfChannels = audioBuffers[0].numberOfChannels;
        const sampleRate = audioBuffers[0].sampleRate;

        // 合并音频数据
        const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.length, 0);
        const mergedBuffer = audioContext.createBuffer(
            numberOfChannels,
            totalLength,
            sampleRate
        );

        let offset = 0;
        for (const buffer of audioBuffers) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const mergedData = mergedBuffer.getChannelData(channel);
                const segmentData = buffer.getChannelData(channel);
                mergedData.set(segmentData, offset);
            }
            offset += buffer.length;
        }

        // 转换为WAV
        return await this.audioBufferToWav(mergedBuffer);
    }

    /**
     * Blob转ArrayBuffer
     */
    blobToArrayBuffer(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(blob);
        });
    }

    /**
     * Blob转Base64
     */
    blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    /**
     * 调整音量
     * @param {AudioBuffer} audioBuffer - 音频缓冲区
     * @param {number} volume - 音量倍数 (1.0 = 原音量)
     * @returns {Promise<AudioBuffer>} 调整后的AudioBuffer
     */
    async adjustVolume(audioBuffer, volume) {
        this.ensureInitialized();

        const numberOfChannels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;

        // 合并所有声道数据
        const interleavedData = new Float32Array(length * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                interleavedData[i * numberOfChannels + channel] = channelData[i];
            }
        }

        // 复制到WASM内存
        const wasmFloatView = new Float32Array(this.wasmMemory.buffer);
        wasmFloatView.set(interleavedData, 0);

        // 调用WASM音量调整函数
        this.wasmModule.wasm_adjust_volume(0, volume);

        // 从WASM内存提取调整后的数据
        const adjustedData = new Float32Array(
            this.wasmMemory.buffer.slice(0, interleavedData.length * 4)
        );

        // 创建新的AudioBuffer
        const adjustedBuffer = audioBuffer.context.createBuffer(
            numberOfChannels,
            length,
            audioBuffer.sampleRate
        );

        // 将数据分离回各个声道
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = adjustedBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                channelData[i] = adjustedData[i * numberOfChannels + channel];
            }
        }

        return adjustedBuffer;
    }

    /**
     * 音频重采样
     * @param {AudioBuffer} audioBuffer - 音频缓冲区
     * @param {number} targetSampleRate - 目标采样率
     * @returns {Promise<AudioBuffer>} 重采样后的AudioBuffer
     */
    async resampleAudio(audioBuffer, targetSampleRate) {
        this.ensureInitialized();

        if (audioBuffer.sampleRate === targetSampleRate) {
            return audioBuffer; // 采样率相同，无需处理
        }

        const numberOfChannels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;

        // 合并所有声道数据
        const interleavedData = new Float32Array(length * numberOfChannels);
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = audioBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                interleavedData[i * numberOfChannels + channel] = channelData[i];
            }
        }

        // 复制到WASM内存
        const wasmFloatView = new Float32Array(this.wasmMemory.buffer);
        wasmFloatView.set(interleavedData, 0);

        // 调用WASM重采样函数
        const targetLength = this.wasmModule.wasm_resample_audio(
            0, // 需要传递AudioBuffer结构体
            targetSampleRate
        );

        if (targetLength === 0) {
            throw new Error('重采样失败');
        }

        // 从WASM内存提取重采样后的数据
        const bufferSize = this.wasmModule.wasm_get_buffer_size();
        const resampledData = new Float32Array(
            this.wasmMemory.buffer.slice(0, bufferSize)
        );

        // 创建新的AudioBuffer
        const resampledBuffer = audioBuffer.context.createBuffer(
            numberOfChannels,
            targetLength,
            targetSampleRate
        );

        // 将数据分离回各个声道
        for (let channel = 0; channel < numberOfChannels; channel++) {
            const channelData = resampledBuffer.getChannelData(channel);
            for (let i = 0; i < targetLength; i++) {
                channelData[i] = resampledData[i * numberOfChannels + channel];
            }
        }

        return resampledBuffer;
    }

    /**
     * 清理WASM资源
     */
    cleanup() {
        if (this.wasmModule && this.wasmModule.wasm_cleanup) {
            this.wasmModule.wasm_cleanup();
        }
        this.initialized = false;
        this.wasmModule = null;
        this.wasmMemory = null;
    }

    /**
     * 获取性能统计信息
     */
    getStats() {
        return {
            initialized: this.initialized,
            memoryUsage: this.wasmMemory ? this.wasmMemory.buffer.byteLength : 0
        };
    }
}

// 导出为全局对象
window.WASMAudioProcessor = WASMAudioProcessor;

// 便捷函数：创建并初始化处理器
window.createAudioProcessor = async function(wasmBinaryUrl) {
    const processor = new WASMAudioProcessor();

    try {
        const response = await fetch(wasmBinaryUrl);
        const wasmBinary = await response.arrayBuffer();
        await processor.initialize(wasmBinary);
        return processor;
    } catch (error) {
        console.error('创建音频处理器失败:', error);
        throw error;
    }
};
