#!/usr/bin/env python3
"""Explicit candidate overlay; NOT included in prepare-controller/image builds yet."""
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import sys

package = Path(__file__).resolve().parents[1]
context = Path(sys.argv[1]).resolve()
source_path = context / 'packages/adapter-utils/src/ssh.ts'
evidence = json.loads((package / 'fixtures/admission/source-attestation.json').read_text())
assert hashlib.sha256(source_path.read_bytes()).hexdigest() == evidence['liveSourceSha256']['packages/adapter-utils/src/ssh.ts'], 'Unexpected PR #4 SSH source'
spec = importlib.util.spec_from_file_location('assemble', package / 'images/controller/ssh-admission/assemble.py')
assembly = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assembly)
sources = assembly.sources()
source = source_path.read_text()


def replace(old, new):
    global source
    assert source.count(old) == 1, 'Unexpected source anchor: ' + old[:100]
    source = source.replace(old, new)


addition = '\n'.join('const ADMISSION_SSH_' + key.upper() + ' = ' + json.dumps(value) + ';' for key, value in sources.items())
addition += '\n\n' + (package / 'images/controller/ssh-admission/transport.ts.txt').read_text() + '\n'
replace('export async function buildSshSpawnTarget(input: {', addition + 'export async function buildSshSpawnTarget(input: {')
replace('''export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;''', '''export async function buildSshSpawnTarget(input: {
  spec: SshRemoteExecutionSpec;
  admission?: SshLaunchAuthorization;''')
replace('''  for (const key of Object.keys(input.env)) {''', '''  // Snapshot before the first await: caller mutation cannot alter journal identity.
  const admission = input.admission === undefined ? undefined : snapshotSshLaunchAuthorization(input.admission);
  for (const key of Object.keys(input.env)) {''')
replace('  const sshInvocationId = randomUUID();', '  const sshInvocationId = admission?.binding.invocationId ?? randomUUID();')
replace('''  const remoteCommandParts = ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_SUPERVISOR), shellQuote(invocationDir), shellQuote(providerCommand)].join(" ");''', '''  const remoteCommandParts = admission
    ? ["python3", "-I", "-c", shellQuote(ADMISSION_SSH_SUPERVISOR), shellQuote(admission.fenceRoot),
      shellQuote(providerCommand), shellQuote(JSON.stringify(admission.binding))].join(" ")
    : ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_SUPERVISOR), shellQuote(invocationDir), shellQuote(providerCommand)].join(" ");''')
replace('''        ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_STOP), shellQuote(invocationDir)].join(" "),''', '''        (admission
          ? ["python3", "-I", "-c", shellQuote(ADMISSION_SSH_STOP), shellQuote(admission.fenceRoot), shellQuote(JSON.stringify(admission.binding))]
          : ["python3", "-I", "-c", shellQuote(EVALUATION_SSH_STOP), shellQuote(invocationDir)]).join(" "),''')
replace('''          if (JSON.parse(stdout).stopped !== true) throw new Error("Remote descendant stop is unverified");''', '''          const receipt = JSON.parse(stdout);
          if (receipt.stopped !== true || (admission && (
            !receipt.binding || Object.keys(receipt.binding).length !== Object.keys(admission.binding).length ||
            (Object.keys(admission.binding) as Array<keyof SshLaunchAuthorization["binding"]>)
              .some((key) => receipt.binding[key] !== admission.binding[key])
          ))) throw new Error("Remote descendant stop is unverified");''')
# Every-command lifetime overlay is attested separately from the original
# final-invocation candidate. Both exact inputs must match before any write.
commands = package / 'images/controller/ssh-admission'
manifest = json.loads((commands / 'commands-manifest.json').read_text())
assert hashlib.sha256(source.encode()).hexdigest() == manifest['baselineSha256'], 'Unexpected initial admission transport'
candidate = (commands / 'source/ssh.ts').read_text()
assert hashlib.sha256(candidate.encode()).hexdigest() == manifest['sourceSha256'], 'Changed command transport'
for name, protocol in sources.items():
    if name == 'epoch':
        protocol += "print(json.dumps({'epoch': identity(json.loads(sys.argv[3])['epoch']), 'fenceRoot': str(Path(sys.argv[1]))}))\n"
    match = re.search(r'const ADMISSION_SSH_' + name.upper() + r' = (.*);', candidate)
    assert match and json.loads(match.group(1)) == protocol, 'Transport protocol differs from assembled supervisor: ' + name
source_path.write_text(candidate)
print('Applied candidate SSH admission transport/subreaper overlay; every executable helper requires its own journal when host policy is installed')
