#!/usr/bin/env python3
"""Check health semantics and the controller-local execution guard without models."""
import json, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
probe=(root/'images/controller/healthcheck.mjs').as_uri()
for ok,status,expected in [(True,'ok',0),(True,'starting',1),(False,'ok',1),(False,'unhealthy',1)]:
    code="globalThis.fetch = async () => ({ok: "+json.dumps(ok)+", json: async () => ({status: "+json.dumps(status)+"})}); await import("+json.dumps(probe)+");"
    result=subprocess.run(['node','--input-type=module','-e',code],capture_output=True)
    assert result.returncode==expected,(status,result.returncode)
code="globalThis.fetch = async () => { throw new Error('simulated connection failure'); }; await import("+json.dumps(probe)+");"
assert subprocess.run(['node','--input-type=module','-e',code],capture_output=True).returncode!=0
result=subprocess.run(['sh',str(root/'images/controller/deny-local.sh')],capture_output=True,text=True)
assert result.returncode==126 and 'SSH environment' in result.stderr
print('PASS: readiness rejects starting/unhealthy/failed connections; controller-local guard exits 126. Mock responses only; real application startup NOT RUN.')
