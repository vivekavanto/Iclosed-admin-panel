"""Install only the reviewed hosted-dev user services. Default is a dry run."""
import argparse,os,pathlib,plistlib,subprocess
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--node',required=True);p.add_argument('--apply',action='store_true');args=p.parse_args()
root=pathlib.Path(args.root).resolve();node=pathlib.Path(args.node).resolve()
if not root.is_dir() or not node.is_file() or not os.access(node,os.X_OK):raise SystemExit('Existing worker root and executable Node are required.')
if root.stat().st_mode&0o077:raise SystemExit('Worker root must be owner-only.')
source=root/'app';private=root/'private';logs=root/'logs';agents=pathlib.Path.home()/'Library/LaunchAgents'
services=[('operations','worker.mjs',['--role=operations']),('audits','worker.mjs',['--role=audits']),('discovery','discovery.mjs',[]),('daily-sync','daily-sync.mjs',[])]
for role,script,extra in services:
 label='ca.iclosed.legal-assistant.hosted-dev.'+role;env=private/(role+'.env')
 if not env.is_file() or env.stat().st_mode&0o077:raise SystemExit('Each scoped private environment must exist with owner-only permissions.')
 if 'ORCHESTRATOR_LOCAL_STATE_DIR=' in env.read_text():raise SystemExit('Hosted services must not point at the local register.')
 program=source/'scripts/legal-assistant-hosted'/script
 if not program.is_file():raise SystemExit('The verified worker source is missing.')
 config={'Label':label,'ProgramArguments':[str(node),'--env-file='+str(env),'--experimental-strip-types',str(program),*extra],'WorkingDirectory':str(source),'EnvironmentVariables':{'NODE_ENV':'production','PATH':str(node.parent)+':/usr/bin:/bin'},'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':15,'StandardOutPath':str(logs/(role+'.log')),'StandardErrorPath':str(logs/(role+'.error.log'))}
 if not args.apply:print('Prepared '+label);continue
 agents.mkdir(parents=True,exist_ok=True);logs.mkdir(mode=0o700,exist_ok=True)
 target=agents/(label+'.plist')
 if target.exists():
  if plistlib.loads(target.read_bytes())!=config:raise SystemExit('Existing service differs. Drain its work and review a separate update.')
  if subprocess.run(['/bin/launchctl','print','gui/'+str(os.getuid())+'/'+label],capture_output=True).returncode==0:
   print('Existing service retained '+label);continue
 for name in ['StandardOutPath','StandardErrorPath']:
  file=pathlib.Path(config[name]);file.touch(mode=0o600,exist_ok=True);os.chmod(file,0o600)
 if not target.exists():
  with target.open('xb') as f:plistlib.dump(config,f)
  os.chmod(target,0o600)
 subprocess.run(['/bin/launchctl','bootstrap','gui/'+str(os.getuid()),str(target)],check=True)
 print('Installed '+label)
