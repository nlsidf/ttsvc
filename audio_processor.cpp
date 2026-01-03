// 音频处理 WASM 模块 - C/C++ 源码
// 用于优化 ivc.html 中的流式音频处理

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

// WAV文件头结构
typedef struct {
    char riff[4];           // "RIFF"
    uint32_t file_size;     // 文件大小 - 8
    char wave[4];           // "WAVE"
    char fmt[4];            // "fmt "
    uint32_t fmt_size;      // fmt chunk 大小
    uint16_t audio_format;  // 音频格式 (1 = PCM)
    uint16_t num_channels;  // 声道数
    uint32_t sample_rate;   // 采样率
    uint32_t byte_rate;     // 字节率
    uint16_t block_align;   // 块对齐
    uint16_t bits_per_sample; // 位深
    char data[4];           // "data"
    uint32_t data_size;     // 数据大小
} __attribute__((packed)) WAVHeader;

// 音频缓冲区信息
typedef struct {
    float* data;            // 浮点音频数据
    uint32_t length;        // 采样点数
    uint16_t num_channels;  // 声道数
    uint32_t sample_rate;   // 采样率
} AudioBuffer;

// 简单的内存管理器
typedef struct {
    uint8_t* buffer;
    uint32_t size;
    uint32_t capacity;
} MemoryBuffer;

// 全局内存缓冲区
MemoryBuffer g_memory_buffer = {NULL, 0, 0};

// 导出函数声明

// 内存管理
extern "C" {

// 初始化内存缓冲区
uint32_t wasm_init_memory(uint32_t size) {
    if (g_memory_buffer.buffer) {
        free(g_memory_buffer.buffer);
    }
    g_memory_buffer.buffer = (uint8_t*)malloc(size);
    if (!g_memory_buffer.buffer) return 0;

    g_memory_buffer.capacity = size;
    g_memory_buffer.size = 0;
    return size;
}

// 获取内存缓冲区指针
uint8_t* wasm_get_memory_buffer() {
    return g_memory_buffer.buffer;
}

// 清理内存
void wasm_cleanup() {
    if (g_memory_buffer.buffer) {
        free(g_memory_buffer.buffer);
        g_memory_buffer.buffer = NULL;
    }
    g_memory_buffer.size = 0;
    g_memory_buffer.capacity = 0;
}

// AudioBuffer转WAV
// 输入: float数组, 长度, 声道数, 采样率, 位深
// 输出: WAV数据 (存储在g_memory_buffer中)
uint32_t wasm_audio_buffer_to_wav(
    float* audio_data,
    uint32_t length,
    uint16_t num_channels,
    uint32_t sample_rate,
    uint16_t bits_per_sample
) {
    uint16_t bytes_per_sample = bits_per_sample / 8;
    uint16_t block_align = num_channels * bytes_per_sample;
    uint32_t data_size = length * block_align;
    uint32_t total_size = 44 + data_size;

    // 检查缓冲区是否足够
    if (total_size > g_memory_buffer.capacity) {
        // 重新分配
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, total_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = total_size;
    }

    WAVHeader* header = (WAVHeader*)g_memory_buffer.buffer;

    // 填充WAV文件头
    memcpy(header->riff, "RIFF", 4);
    header->file_size = total_size - 8;
    memcpy(header->wave, "WAVE", 4);
    memcpy(header->fmt, "fmt ", 4);
    header->fmt_size = 16;
    header->audio_format = 1; // PCM
    header->num_channels = num_channels;
    header->sample_rate = sample_rate;
    header->byte_rate = sample_rate * block_align;
    header->block_align = block_align;
    header->bits_per_sample = bits_per_sample;
    memcpy(header->data, "data", 4);
    header->data_size = data_size;

    // 编码音频数据
    uint8_t* data_ptr = g_memory_buffer.buffer + 44;

    if (bits_per_sample == 16) {
        int16_t* int_data = (int16_t*)data_ptr;
        for (uint32_t i = 0; i < length * num_channels; i++) {
            // 将浮点 (-1.0 到 1.0) 转换为 16位整数
            float sample = audio_data[i];
            sample = fmaxf(-1.0f, fminf(1.0f, sample));
            int_data[i] = (int16_t)(sample < 0 ? sample * 0x8000 : sample * 0x7FFF);
        }
    } else if (bits_per_sample == 24) {
        uint8_t* byte_data = data_ptr;
        for (uint32_t i = 0; i < length * num_channels; i++) {
            float sample = audio_data[i];
            sample = fmaxf(-1.0f, fminf(1.0f, sample));
            int32_t int_sample = (int32_t)(sample < 0 ? sample * 0x800000 : sample * 0x7FFFFF);

            // 小端序存储24位
            byte_data[i * 3] = int_sample & 0xFF;
            byte_data[i * 3 + 1] = (int_sample >> 8) & 0xFF;
            byte_data[i * 3 + 2] = (int_sample >> 16) & 0xFF;
        }
    }

    g_memory_buffer.size = total_size;
    return total_size;
}

// WAV转AudioBuffer
// 输入: WAV数据指针, 大小
// 输出: 音频参数和采样数
uint32_t wasm_wav_to_audio_buffer(
    uint8_t* wav_data,
    uint32_t wav_size,
    AudioBuffer* output
) {
    if (wav_size < 44) return 0;

    WAVHeader* header = (WAVHeader*)wav_data;

    // 验证WAV格式
    if (memcmp(header->riff, "RIFF", 4) != 0 ||
        memcmp(header->wave, "WAVE", 4) != 0 ||
        memcmp(header->fmt, "fmt ", 4) != 0) {
        return 0;
    }

    uint16_t bits_per_sample = header->bits_per_sample;
    uint16_t num_channels = header->num_channels;
    uint32_t sample_rate = header->sample_rate;
    uint16_t bytes_per_sample = bits_per_sample / 8;

    // 计算采样点数
    uint32_t num_samples = header->data_size / (num_channels * bytes_per_sample);

    // 分配内存
    uint32_t buffer_size = num_samples * num_channels * sizeof(float);
    if (buffer_size > g_memory_buffer.capacity) {
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, buffer_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = buffer_size;
    }

    output->data = (float*)g_memory_buffer.buffer;
    output->length = num_samples;
    output->num_channels = num_channels;
    output->sample_rate = sample_rate;

    // 解码音频数据
    uint8_t* data_ptr = wav_data + 44;

    if (bits_per_sample == 16) {
        int16_t* int_data = (int16_t*)data_ptr;
        for (uint32_t i = 0; i < num_samples * num_channels; i++) {
            output->data[i] = (float)int_data[i] / (int_data[i] < 0 ? 0x8000 : 0x7FFF);
        }
    } else if (bits_per_sample == 24) {
        uint8_t* byte_data = data_ptr;
        for (uint32_t i = 0; i < num_samples * num_channels; i++) {
            int32_t int_sample = (int32_t)byte_data[i * 3] |
                                 ((int32_t)byte_data[i * 3 + 1] << 8) |
                                 ((int32_t)(int8_t)byte_data[i * 3 + 2] << 16);
            output->data[i] = (float)int_sample / (int_sample < 0 ? 0x800000 : 0x7FFFFF);
        }
    }

    g_memory_buffer.size = buffer_size;
    return num_samples;
}

// 音频切片 - 从AudioBuffer中提取片段
// 输入: 源buffer, 起始采样, 长度
// 输出: 切片后的数据 (存储在g_memory_buffer中)
uint32_t wasm_slice_audio(
    AudioBuffer* source,
    uint32_t start_sample,
    uint32_t slice_length
) {
    if (start_sample + slice_length > source->length) {
        slice_length = source->length - start_sample;
    }

    uint32_t buffer_size = slice_length * source->num_channels * sizeof(float);

    if (buffer_size > g_memory_buffer.capacity) {
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, buffer_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = buffer_size;
    }

    float* slice_data = (float*)g_memory_buffer.buffer;

    // 复制音频数据
    for (uint16_t ch = 0; ch < source->num_channels; ch++) {
        memcpy(slice_data + ch * slice_length,
               source->data + ch * source->length + start_sample,
               slice_length * sizeof(float));
    }

    g_memory_buffer.size = buffer_size;
    return slice_length;
}

// 音频合并 - 合并多个AudioBuffer
// 输入: buffer数组, 数量, 输出buffer
// 输出: 合并后的采样点数
uint32_t wasm_merge_audio_buffers(
    AudioBuffer* buffers,
    uint32_t num_buffers,
    AudioBuffer* output
) {
    if (num_buffers == 0) return 0;

    uint16_t num_channels = buffers[0].num_channels;
    uint32_t sample_rate = buffers[0].sample_rate;
    uint32_t total_length = 0;

    // 计算总长度
    for (uint32_t i = 0; i < num_buffers; i++) {
        if (buffers[i].num_channels != num_channels ||
            buffers[i].sample_rate != sample_rate) {
            return 0; // 格式不匹配
        }
        total_length += buffers[i].length;
    }

    uint32_t buffer_size = total_length * num_channels * sizeof(float);

    if (buffer_size > g_memory_buffer.capacity) {
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, buffer_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = buffer_size;
    }

    output->data = (float*)g_memory_buffer.buffer;
    output->length = total_length;
    output->num_channels = num_channels;
    output->sample_rate = sample_rate;

    // 合并音频数据
    uint32_t offset = 0;
    for (uint32_t i = 0; i < num_buffers; i++) {
        for (uint16_t ch = 0; ch < num_channels; ch++) {
            memcpy(output->data + ch * total_length + offset,
                   buffers[i].data + ch * buffers[i].length,
                   buffers[i].length * sizeof(float));
        }
        offset += buffers[i].length;
    }

    g_memory_buffer.size = buffer_size;
    return total_length;
}

// 音频重采样 (简单的线性插值)
// 输入: 源buffer, 目标采样率
// 输出: 重采样后的数据
uint32_t wasm_resample_audio(
    AudioBuffer* source,
    uint32_t target_sample_rate,
    AudioBuffer* output
) {
    if (source->sample_rate == target_sample_rate) {
        // 采样率相同，直接复制
        return source->length;
    }

    double ratio = (double)target_sample_rate / source->sample_rate;
    uint32_t target_length = (uint32_t)(source->length * ratio);
    uint32_t buffer_size = target_length * source->num_channels * sizeof(float);

    if (buffer_size > g_memory_buffer.capacity) {
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, buffer_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = buffer_size;
    }

    output->data = (float*)g_memory_buffer.buffer;
    output->length = target_length;
    output->num_channels = source->num_channels;
    output->sample_rate = target_sample_rate;

    // 线性插值重采样
    for (uint16_t ch = 0; ch < source->num_channels; ch++) {
        float* src = source->data + ch * source->length;
        float* dst = output->data + ch * target_length;

        for (uint32_t i = 0; i < target_length; i++) {
            double src_pos = i / ratio;
            uint32_t src_idx = (uint32_t)src_pos;
            double frac = src_pos - src_idx;

            if (src_idx >= source->length - 1) {
                dst[i] = src[source->length - 1];
            } else {
                dst[i] = (float)(src[src_idx] * (1 - frac) + src[src_idx + 1] * frac);
            }
        }
    }

    g_memory_buffer.size = buffer_size;
    return target_length;
}

// 音音量调整
// 输入: buffer, 音量倍数
void wasm_adjust_volume(AudioBuffer* buffer, float volume) {
    uint32_t total_samples = buffer->length * buffer->num_channels;

    for (uint32_t i = 0; i < total_samples; i++) {
        buffer->data[i] = fmaxf(-1.0f, fminf(1.0f, buffer->data[i] * volume));
    }
}

// 音频交叉淡入淡出
// 输入: buffer1, buffer2, 淡入淡出点数
uint32_t wasm_cross_fade(
    AudioBuffer* buffer1,
    AudioBuffer* buffer2,
    uint32_t fade_length,
    AudioBuffer* output
) {
    uint32_t total_length = buffer1->length + buffer2->length - fade_length;
    uint16_t num_channels = buffer1->num_channels;
    uint32_t buffer_size = total_length * num_channels * sizeof(float);

    if (buffer_size > g_memory_buffer.capacity) {
        uint8_t* new_buffer = (uint8_t*)realloc(g_memory_buffer.buffer, buffer_size);
        if (!new_buffer) return 0;
        g_memory_buffer.buffer = new_buffer;
        g_memory_buffer.capacity = buffer_size;
    }

    output->data = (float*)g_memory_buffer.buffer;
    output->length = total_length;
    output->num_channels = num_channels;
    output->sample_rate = buffer1->sample_rate;

    // 复制buffer1的非淡出部分
    uint32_t offset = 0;
    for (uint16_t ch = 0; ch < num_channels; ch++) {
        memcpy(output->data + ch * total_length,
               buffer1->data + ch * buffer1->length,
               (buffer1->length - fade_length) * sizeof(float));
    }

    // 交叉淡入淡出
    for (uint32_t i = 0; i < fade_length; i++) {
        float fade_out = (float)i / fade_length;
        float fade_in = 1.0f - fade_out;

        for (uint16_t ch = 0; ch < num_channels; ch++) {
            float* dst = output->data + ch * total_length + (buffer1->length - fade_length) + i;
            float* src1 = buffer1->data + ch * buffer1->length + (buffer1->length - fade_length) + i;
            float* src2 = buffer2->data + ch * buffer2->length + i;

            dst[0] = src1[0] * fade_out + src2[0] * fade_in;
        }
    }

    // 复制buffer2的非淡入部分
    offset = buffer1->length - fade_length + fade_length;
    for (uint16_t ch = 0; ch < num_channels; ch++) {
        memcpy(output->data + ch * total_length + offset,
               buffer2->data + ch * buffer2->length + fade_length,
               (buffer2->length - fade_length) * sizeof(float));
    }

    g_memory_buffer.size = buffer_size;
    return total_length;
}

// 获取当前缓冲区大小
uint32_t wasm_get_buffer_size() {
    return g_memory_buffer.size;
}

} // extern "C"
