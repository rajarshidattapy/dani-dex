"""Prepare the development-only offline Kitten runtime. Release packaging is a separate gate."""
import pathlib,subprocess,sys,hashlib,json
ROOT=pathlib.Path(__file__).resolve().parent.parent
RUNTIME=ROOT/'.dani-dex-build/kitten'
RUNTIME.mkdir(parents=True,exist_ok=True)
python=RUNTIME/'venv/bin/python'
if not python.exists():
 subprocess.run([sys.executable,'-m','venv',str(RUNTIME/'venv')],check=True)
subprocess.run([str(python),'-m','ensurepip'],check=True)
subprocess.run([str(python),'-m','pip','install','numpy==1.26.4','onnxruntime==1.23.2','soundfile==0.14.0','phonemizer-fork==3.3.2','espeakng-loader==0.2.4','huggingface-hub==2.2.0'],check=True)
subprocess.run([str(python),'-m','pip','install','--no-deps','https://github.com/KittenML/KittenTTS/releases/download/0.8.1/kittentts-0.8.1-py3-none-any.whl'],check=True)
# Upstream 0.8.1 imports Misaki without using it; do not ship its Torch/spaCy tree.
patch="from pathlib import Path;import sysconfig;p=Path(sysconfig.get_paths()['purelib'])/'kittentts/onnx_model.py';s=p.read_text();p.write_text(s.replace('from misaki import en, espeak\\n',''))"
subprocess.run([str(python),'-c',patch],check=True)
revision='7a1db645b1f3ab9420761d87428e042b9cec3f26'
assets={'config.json':(688,'b66006ccbeccd4de5fc3c9272059c47f5725df7215fd889785c03602652fab64'),'kitten_tts_nano_v0_8.onnx':(56767095,'320564d2615f235de972ca27a7f39551c94185cfa24ca85b07a29084135f1e5e'),'voices.npz':(3278902,'8aa7cee235abb0739cb51e6559685f65a4dacd95568833d05699b1633f519b3f')}
for name,(size,digest)in assets.items():
 code="from huggingface_hub import hf_hub_download;print(hf_hub_download('KittenML/kitten-tts-nano-0.8',"+repr(name)+",revision="+repr(revision)+",cache_dir="+repr(str(RUNTIME/'model'))+"))"
 path=pathlib.Path(subprocess.check_output([str(python),'-c',code],text=True).strip())
 data=path.read_bytes()
 if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:raise RuntimeError('Kitten asset verification failed: '+name)
print('Development runtime ready. Release packaging remains unverified.')
