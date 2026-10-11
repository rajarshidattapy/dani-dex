#include "whisper.h"
#include <array>
#include <chrono>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <string>
#include <vector>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif
static std::string quoted(const std::string &s) {
    std::string r = "\"";
    for (unsigned char c: s) {
        if(c=='"'||c=='\\'){r+='\\';r+=c;}
        else if(c=='\n')r+="\\n"; else if(c=='\r')r+="\\r"; else if(c=='\t')r+="\\t";
        else if(c<32){char b[7];std::snprintf(b,sizeof(b),"\\u%04x",c);r+=b;}else r+=c;
    }
    return r+"\"";
}
int main(int argc,char **argv){
    if(argc!=4)return 2;
#ifdef _WIN32
    _setmode(_fileno(stdin),_O_BINARY);
#endif
    whisper_log_set([](enum ggml_log_level,const char*,void*){},nullptr);
    auto cp=whisper_context_default_params();cp.use_gpu=false;
    auto *ctx=whisper_init_from_file_with_params_no_state(argv[1],cp);if(!ctx)return 3;
    const int threads=std::atoi(argv[3]);if(threads<1||threads>8){whisper_free(ctx);return 2;}
    auto vp=whisper_vad_default_context_params();vp.use_gpu=false;vp.n_threads=1;auto* vad=whisper_vad_init_from_file_with_params(argv[2],vp);if(!vad){whisper_free(ctx);return 3;}
    std::puts("READY");std::fflush(stdout);
    int status=0;
    for(;;){
        std::array<uint32_t,3> header{};
        const auto n=std::fread(header.data(),1,12,stdin);if(n==0&&std::feof(stdin))break;
        if(n!=12||header[0]==0||header[0]>480000||header[1]<50||header[1]>1500||header[2]>3){status=4;break;}
        std::vector<float> audio(header[0]);if(std::fread(audio.data(),sizeof(float),audio.size(),stdin)!=audio.size()){status=4;break;}
        bool valid=true;for(float x:audio)if(!std::isfinite(x)||std::fabs(x)>1){valid=false;break;}if(!valid){status=4;break;}
        const char* languages[]={"auto","en","hi","bn"};
        auto p=whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        p.n_threads=threads;p.language=languages[header[2]];p.audio_ctx=1500;p.no_context=true;p.no_timestamps=true;p.beam_search.beam_size=1;p.greedy.best_of=1;p.temperature_inc=0;
        p.print_realtime=false;p.print_progress=false;p.print_timestamps=false;p.print_special=false;
        auto vparams=whisper_vad_default_params();vparams.speech_pad_ms=150;
        auto* segments=whisper_vad_segments_from_samples(vad,vparams,audio.data(),static_cast<int>(audio.size()));
        if(!segments){status=5;break;}
        std::vector<float> trimmed;
        for(int i=0;i<whisper_vad_segments_n_segments(segments);++i){
            const int start=std::max(0,static_cast<int>(whisper_vad_segments_get_segment_t0(segments,i)*160));
            const int end=std::min(static_cast<int>(audio.size()),static_cast<int>(whisper_vad_segments_get_segment_t1(segments,i)*160));
            if(end>start)trimmed.insert(trimmed.end(),audio.begin()+start,audio.begin()+end);
            if(i+1<whisper_vad_segments_n_segments(segments))trimmed.insert(trimmed.end(),1600,0.0f);
        }
        whisper_vad_free_segments(segments);
        if(trimmed.empty()){std::puts("\"\"");std::fflush(stdout);continue;}
        p.vad=false;
        // Shortened encoder contexts caused repeat floods on real saved Mac speech.
        // Full model context is verified here; do not infer safety from sample coverage alone.
        p.audio_ctx=whisper_n_audio_ctx(ctx);
        p.max_tokens=std::min(256,std::max(32,static_cast<int>(trimmed.size()/16000.0*8+16)));
        auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(12);
        p.abort_callback=[](void* data){return std::chrono::steady_clock::now()>=*static_cast<std::chrono::steady_clock::time_point*>(data);};
        p.abort_callback_user_data=&deadline;

        auto* state=whisper_init_state(ctx);if(!state){status=5;break;}
        if(whisper_full_with_state(ctx,state,p,trimmed.data(),static_cast<int>(trimmed.size()))!=0){whisper_free_state(state);status=5;break;}
        std::string text;const int segment_count=whisper_full_n_segments_from_state(state);
        bool capped=false;
        for(int i=0;i<segment_count;++i){if(whisper_full_n_tokens_from_state(state,i)>=p.max_tokens)capped=true;const char*t=whisper_full_get_segment_text_from_state(state,i);if(t)text+=t;}
        whisper_free_state(state);if(capped){status=5;break;}std::puts(quoted(text).c_str());if(std::fflush(stdout)!=0){status=6;break;}
    }
    whisper_vad_free(vad);whisper_free(ctx);return status;
}
