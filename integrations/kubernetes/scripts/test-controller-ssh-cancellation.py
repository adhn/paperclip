#!/usr/bin/env python3
"""Disposable Docker SSH integration; never reads operator/provider credentials."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

if len(sys.argv) not in (3, 4):
    sys.exit('Usage: test-controller-ssh-cancellation.py CONTROLLER RUNNER [TEST_SCRIPT]')
controller, runner = sys.argv[1:3]
test_script = Path(sys.argv[3]).resolve() if len(sys.argv) == 4 else Path(__file__).with_name('test-ssh-cancellation.mjs')
name = 'paperclip-cancel-' + uuid.uuid4().hex[:10]
package = Path(__file__).resolve().parents[1]
def run(*args, **kwargs):
    return subprocess.run(list(args), check=True, text=True, **kwargs)
def output(*args):
    return subprocess.check_output(list(args), text=True).strip()
with tempfile.TemporaryDirectory(prefix=name) as directory:
    root=Path(directory)
    run('ssh-keygen','-q','-t','ed25519','-N','','-f',str(root/'client'))
    resources=[]
    try:
        run('docker','network','create',name,stdout=subprocess.DEVNULL);resources.append(('network',name))
        for suffix in ['state','key','fixture']:
            run('docker','volume','create',name+'-'+suffix,stdout=subprocess.DEVNULL);resources.append(('volume',name+'-'+suffix))
        run('docker','run','--rm','--user','0','--entrypoint','sh','--mount',f'type=volume,src={name}-state,dst=/state','--mount',f'type=volume,src={name}-key,dst=/key', '-i',runner,'-c','chown 1000:1000 /state; chmod 700 /state; cat > /key/authorized_keys; chmod 444 /key/authorized_keys',input=(root/'client.pub').read_text())
        run('docker','run','-d','--name',name,'--network',name,'--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','512m','--cpus','1','--pids-limit','128','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=64m','--mount',f'type=volume,src={name}-state,dst=/home/node','--mount',f'type=volume,src={name}-key,dst=/etc/runner-ssh,readonly','-e','RUNNER_PROVIDER=codex',runner,stdout=subprocess.DEVNULL);resources.append(('container',name))
        for attempt in range(30):
            probe=subprocess.run(['docker','exec',name,'test','-s','/home/node/.ssh/ssh_host_ed25519_key.pub'],capture_output=True)
            if probe.returncode==0:break
            time.sleep(.2)
        else:raise RuntimeError('SSH fixture did not start')
        public=output('docker','exec',name,'cat','/home/node/.ssh/ssh_host_ed25519_key.pub')
        spec={'host':name,'port':2222,'username':'node','remoteCwd':'/home/node/workspaces','remoteWorkspacePath':'/home/node/workspaces','privateKey':(root/'client').read_text(),'knownHosts':f'[{name}]:2222 {public}\n','strictHostKeyChecking':True}
        # Host UIDs differ (workstation 1000, GitHub 1001). Stage only generated
        # fixture data into a UID-1000 volume; never expose operator credentials.
        stage='const fs=require("fs");const x=JSON.parse(fs.readFileSync(0,"utf8"));fs.chownSync("/fixture",1000,1000);fs.chmodSync("/fixture",0o700);for(const [name,data,mode] of [["spec.json",JSON.stringify(x.spec),0o600],["test.mjs",x.script,0o644]]){const p="/fixture/"+name;fs.writeFileSync(p,data,{mode});fs.chownSync(p,1000,1000);}'
        run('docker','run','--rm','--user','0','--entrypoint','node','--mount',f'type=volume,src={name}-fixture,dst=/fixture','-i',controller,'-e',stage,input=json.dumps({'spec':spec,'script':test_script.read_text()}))
        # The provider-free capacity fixture can request one abrupt restart of
        # its own disposable runner. Never expose Docker control to the test or
        # any application runner; the host harness owns this narrow fault.
        resources.append(('container', name+'-controller'))
        controller_process = subprocess.Popen(['docker','run','--rm','--name',name+'-controller','--network',name,'--memory','3g','--memory-swap','5g','--cpus','2','--pids-limit','256','--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,exec,nosuid,nodev,size=768m','--mount',f'type=volume,src={name}-fixture,dst=/fixture,readonly','--entrypoint','node',controller,'--import','/app/server/node_modules/tsx/dist/loader.mjs','/fixture/test.mjs'])
        restarted = False
        deadline = time.monotonic() + 420
        while controller_process.poll() is None:
            if time.monotonic() > deadline:
                controller_process.terminate()
                raise RuntimeError('Disposable SSH fixture exceeded its bounded deadline')
            if not restarted:
                request = subprocess.run(['docker','exec',name,'test','-e','/home/node/.capacity-restart-request'],capture_output=True)
                if request.returncode == 0:
                    run('docker','restart','--time','0',name,stdout=subprocess.DEVNULL)
                    run('docker','exec',name,'touch','/home/node/.capacity-restarted')
                    restarted = True
            time.sleep(.2)
        if controller_process.returncode:
            raise RuntimeError(f'Disposable controller fixture exited {controller_process.returncode}')

    finally:
        for kind,value in reversed(resources):
            subprocess.run(['docker',kind,'rm',*(['-f'] if kind=='container' else []),value],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
