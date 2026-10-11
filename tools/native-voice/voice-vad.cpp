#include "whisper.h"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

// One private stdin/stdout session. The host chooses the verified model, never the renderer.
int main(int argc, char ** argv) {
    if (argc != 2) return 2;
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
#endif
    whisper_log_set([](enum ggml_log_level, const char *, void *) {}, nullptr);
    auto params = whisper_vad_default_context_params();
    params.n_threads = 1;
    params.use_gpu = false;
    auto * context = whisper_vad_init_from_file_with_params(argv[1], params);
    if (context == nullptr) return 3;
    std::array<float, 4096> samples{};
    std::puts("READY");
    std::fflush(stdout);
    int result = 0;
    for (;;) {
        std::array<unsigned char, 4> header{};
        const auto bytes = std::fread(header.data(), 1, header.size(), stdin);
        if (bytes == 0 && std::feof(stdin)) break;
        if (bytes != header.size()) { result = 4; break; }
        const auto count = static_cast<std::uint32_t>(header[0]) |
            (static_cast<std::uint32_t>(header[1]) << 8) |
            (static_cast<std::uint32_t>(header[2]) << 16) |
            (static_cast<std::uint32_t>(header[3]) << 24);
        if (count == 0 || count > samples.size() || count % 512 != 0 ||
            std::fread(samples.data(), sizeof(float), count, stdin) != count) {
            result = 4;
            break;
        }
        bool valid = true;
        for (std::uint32_t i = 0; i < count; ++i) {
            if (!std::isfinite(samples[i]) || std::fabs(samples[i]) > 1.0f) { valid = false; break; }
        }
        if (!valid || !whisper_vad_detect_speech_no_reset(context, samples.data(), static_cast<int>(count))) {
            result = 5;
            break;
        }
        const int size = whisper_vad_n_probs(context);
        const float * probabilities = whisper_vad_probs(context);
        if (size != static_cast<int>(count / 512)) { result = 6; break; }
        for (int i = 0; i < size; ++i) std::printf(i == 0 ? "%.8f" : " %.8f", probabilities[i]);
        std::putchar('\n');
        if (std::fflush(stdout) != 0) { result = 7; break; }
    }
    whisper_vad_free(context);
    return result;
}
