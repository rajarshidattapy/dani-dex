#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>
#include <cmath>
using Load = int (*)(const unsigned char*, unsigned long long);
using Transcribe = int (*)(const float*, int, const char*, const char*, int, char*, int);
static uint32_t le32(const unsigned char* p) { return uint32_t(p[0]) | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24; }
static std::vector<unsigned char> bytes(const std::string& path) { std::ifstream f(path,std::ios::binary); return {std::istreambuf_iterator<char>(f),{}}; }
int main(int argc,char**argv) {
 if(argc!=3) return 2;
 void* lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL); if(!lib) { std::cerr<<"engine-load-failed\n";return 3; }
 auto load=reinterpret_cast<Load>(dlsym(lib,"needle_load")); auto transcribe=reinterpret_cast<Transcribe>(dlsym(lib,"needle_transcribe"));
 if(!load||!transcribe)return 4;
 auto model=bytes(argv[2]); if(model.empty()||load(model.data(),model.size())<0){std::cerr<<"model-load-failed\n";return 5;}
 model.clear();model.shrink_to_fit();std::cout<<"{\"ready\":true}"<<std::endl;
 std::string path; while(std::getline(std::cin,path)) {
  auto tab=path.find("\t"); std::string language; if(tab!=std::string::npos){language=path.substr(tab+1);path.resize(tab);} if(!language.empty()&&language!="en"){std::cout<<"{\"error\":\"invalid-language\"}"<<std::endl;continue;}
  auto wav=bytes(path);if(wav.size()<44||memcmp(wav.data(),"RIFF",4)||memcmp(wav.data()+8,"WAVEfmt ",8)||le32(wav.data()+16)!=16||wav[20]!=1||wav[22]!=1||le32(wav.data()+24)!=16000||wav[34]!=16||memcmp(wav.data()+36,"data",4)||le32(wav.data()+40)!=wav.size()-44||wav.size()>960044||((wav.size()-44)%2)) {std::cout<<"{\"error\":\"invalid-audio\"}"<<std::endl;continue;}
  std::vector<float> pcm((wav.size()-44)/2); for(size_t i=0;i<pcm.size();++i) {int16_t sample=static_cast<int16_t>(uint16_t(wav[44+i*2])|uint16_t(wav[45+i*2])<<8);pcm[i]=sample/32768.f;}
  std::vector<char> output(262144); int n=transcribe(pcm.data(),static_cast<int>(pcm.size()),language.empty()?nullptr:language.c_str(),nullptr,0,output.data(),static_cast<int>(output.size()));
  if(n<0)std::cout<<"{\"error\":\"inference-failed\"}"<<std::endl;else std::cout<<output.data()<<std::endl;
 }
 dlclose(lib);return 0;
}
