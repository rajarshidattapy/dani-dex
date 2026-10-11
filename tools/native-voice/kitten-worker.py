"""Offline Kitten synthesis worker. Private text enters via stdin, never argv or logs."""
import os,sys,json,time,contextlib
os.environ['OMP_NUM_THREADS']='2'
os.environ['OPENBLAS_NUM_THREADS']='2'
os.environ['HF_HUB_OFFLINE']='1'
import onnxruntime as ort
import numpy as np
import soundfile as sf
from kittentts.onnx_model import KittenTTS_1_Onnx
root=sys.argv[1]
with open(os.path.join(root,'config.json')) as f: config=json.load(f)
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
original=ort.InferenceSession
ort.InferenceSession=lambda path: original(path,sess_options=options,providers=['CPUExecutionProvider'])
with contextlib.redirect_stdout(sys.stderr):
 model=KittenTTS_1_Onnx(os.path.join(root,config['model_file']),os.path.join(root,config['voices']),speed_priors=config.get('speed_priors',{}),voice_aliases=config.get('voice_aliases',{}))
print(json.dumps({'ready':True}),flush=True)
for line in sys.stdin:
 try:
  request=json.loads(line)
  text=request['text'].strip()
  if not text or len(text)>32768: raise ValueError('invalid text')
  start=time.monotonic()
  with contextlib.redirect_stdout(sys.stderr): audio=model.generate(text,voice='Jasper',clean_text=True)
  if len(audio)>24000*300 or not np.isfinite(audio).all():raise ValueError('invalid audio')
  sf.write(request['path'],audio,24000,subtype='PCM_16')
  os.chmod(request['path'],0o600)
  print(json.dumps({'ok':True,'seconds':len(audio)/24000,'elapsed_ms':(time.monotonic()-start)*1000}),flush=True)
 except Exception:
  print(json.dumps({'ok':False}),flush=True)
