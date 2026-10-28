"""Prepare only isolated native dependencies. No credentials, state or services are installed."""
import os,pathlib,subprocess
root=pathlib.Path.home()/'Library/Application Support/iClosed/LegalAssistant/HostedDevWorker'
root.mkdir(mode=0o700,parents=True,exist_ok=True)
os.chmod(root,0o700)
uv=root/'tools/bin/uv'
if not uv.is_file():raise SystemExit('Prepare pinned uv tooling in the isolated tools environment first.')
env={**os.environ,'UV_PYTHON_INSTALL_DIR':str(root/'python'),'UV_CACHE_DIR':str(root/'cache/uv')}
subprocess.run([str(uv),'python','install','3.13.11','--no-bin','--no-config'],env=env,check=True)
if not (root/'.venv').exists():subprocess.run([str(uv),'venv',str(root/'.venv'),'--python','3.13.11','--no-config'],env=env,check=True)
subprocess.run([str(uv),'pip','install','--python',str(root/'.venv/bin/python'),'-r',str(pathlib.Path(__file__).with_name('requirements.lock')),'--no-config'],env=env,check=True)
print('Isolated native worker dependencies prepared; no services started.')
