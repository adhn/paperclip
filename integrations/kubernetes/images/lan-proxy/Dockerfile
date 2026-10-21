FROM caddy:2.11.7@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772
# Listen on 8443; a file capability is unnecessary and cannot execute when
# the runtime drops every capability. Do not add NET_BIND_SERVICE to the pod.
RUN setcap -r /usr/bin/caddy
USER 1000:1000
