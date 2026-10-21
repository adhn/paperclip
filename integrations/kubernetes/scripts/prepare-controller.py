#!/usr/bin/env python3
"""Prepare a pinned source build context; no cluster access or registry writes."""
import hashlib, json, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
inputs = json.loads((root / 'images/inputs.json').read_text())
if len(sys.argv) != 2:
    sys.exit('Usage: prepare-controller.py NEW_BUILD_CONTEXT_DIRECTORY')
context = Path(sys.argv[1]).resolve()
if context.exists():
    sys.exit('Build context must not already exist')
context.mkdir(parents=True)
subprocess.run(['git','init',str(context)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['git','-C',str(context),'fetch','--depth=1','https://github.com/paperclipai/paperclip.git',inputs['sourceRevision']],check=True)
subprocess.run(['git','-C',str(context),'checkout','--detach','FETCH_HEAD'],check=True)
actual=subprocess.check_output(['git','-C',str(context),'rev-parse','HEAD'],text=True).strip()
assert actual == inputs['sourceRevision']
lock=(root/'images/controller/pnpm-lock.yaml').read_bytes()
assert hashlib.sha256(lock).hexdigest() == inputs['controllerLockSha256']
(context/'pnpm-lock.yaml').write_bytes(lock)
recipe=(context/'Dockerfile').read_text()
old='FROM node:24-trixie-slim AS base'
assert recipe.count(old)==1
recipe=recipe.replace(old,'FROM '+inputs['nodeBase']+' AS base')
old='RUN pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile && pnpm install --frozen-lockfile'
assert recipe.count(old)==1
recipe=recipe.replace(old,'RUN pnpm install --frozen-lockfile')
# Remove unpinned local harness installs, retaining openssh-client in production.
lines=recipe.splitlines()
matches=[i for i,line in enumerate(lines) if 'npm install --global --omit=dev @anthropic-ai/claude-code@latest' in line]
assert len(matches)==1
lines[matches[0]]='  && true \\'
recipe='\n'.join(lines)+'\n'
# The accepted scope is SSH with CLI engines. The upstream optional provider
# pack serves OpenCode/ACPX and runs a separate pnpm deploy that resolves a new
# production graph during image construction. Omit that unused pack rather
# than introducing a second, non-frozen installation. Keep its empty directory
# so the upstream production COPY remains valid; pack-dependent engines are
# unavailable in this evaluation image.
start=recipe.index('FROM build AS runner-provider-pack\n')
end=recipe.index('FROM base AS production\n',start)
recipe=recipe[:start]+'FROM build AS runner-provider-pack\nRUN mkdir -p /provider-pack\n\n'+recipe[end:]
# All apt resolution uses the same signed immutable Debian archive.
recipe=recipe.replace('apt-get update', "rm -f /etc/apt/sources.list.d/debian.sources && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/"+inputs['debianSnapshot']+" trixie main\\n' > /etc/apt/sources.list && apt-get update")
assert '@latest' not in recipe.replace('# the @latest CLI tools advance weekly','')
# Reject accidental execution of the selected providers on the controller.
# Locate the next stage after production, preserving all production instructions.
pos=recipe.index('FROM build AS cloud-plugins')
addition="""COPY eval/deny-local.sh eval/healthcheck.mjs /opt/paperclip-eval/
RUN chmod 755 /opt/paperclip-eval/deny-local.sh \\
 && for cli in claude codex gemini; do ln -sf /opt/paperclip-eval/deny-local.sh /usr/local/bin/$cli; done
USER 1000:1000

"""
recipe=recipe[:pos]+addition+recipe[pos:]
(context/'Dockerfile.evaluation').write_text(recipe)
(context/'eval').mkdir()
for filename in ['deny-local.sh','healthcheck.mjs']:
    (context/'eval'/filename).write_bytes((root/'images/controller'/filename).read_bytes())
subprocess.run([sys.executable, str(root/'scripts/patch-ssh-cancellation.py'), str(context)], check=True)
subprocess.run([sys.executable, str(root/'scripts/patch-ssh-lease-stop.py'), str(context)], check=True)
print('Prepared source revision '+actual+'; frozen lock installation and image build remain to be verified.')
