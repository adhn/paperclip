FROM node:24.15.0-trixie-slim@sha256:291be77873bc04731968cacf82f0fcef17cee8cf200c6b6951e2bcab41560eb7
# Immutable Debian archive fixes OS toolchain resolution at a recorded date.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261001T000000Z trixie main\n' > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends openssh-server git curl ca-certificates jq ripgrep python3 python3-venv python3-pip build-essential tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && usermod -p '*' node && mkdir -p /run/sshd /opt/provider /opt/runner /home/node \
 && chown node:node /run/sshd /home/node
ARG PROVIDER
COPY ${PROVIDER}/package.json ${PROVIDER}/package-lock.json /opt/provider/
RUN cd /opt/provider && npm ci --omit=dev && npm cache clean --force \
 && ln -s /opt/provider/node_modules/.bin/$PROVIDER /usr/local/bin/$PROVIDER \
 && ln -s /opt/provider/node_modules/.bin/tsc /usr/local/bin/tsc
ENV PATH=/opt/provider/node_modules/.bin:$PATH HOME=/home/node
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /opt/runner/entrypoint.sh
RUN chmod 755 /opt/runner/entrypoint.sh \
 && dpkg-query -W > /opt/runner/os-packages.txt
USER 1000:1000
EXPOSE 2222
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/runner/entrypoint.sh"]
