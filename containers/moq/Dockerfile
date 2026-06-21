# wave-moq-bridge container — the WAVE Bridge MoQ strand, hosted on CF Containers (WB-6 / E4).
#
# Secret-free: the relay (moq.wave.online) runs with auth default-OFF, so this image carries no token.
# Pure Node — no native deps, no npm install: the proven strand (moq-strand.mjs) is zero-dependency
# and speaks the live relay's draft-18 wire codec over the global WebSocket (stable in Node 22+).
# server.mjs spawns that strand verbatim on each /bridge request — the container artifact is identical
# to what was proven on-prem (the MoQ round-trip harness → MOQ_ROUNDTRIP_PASS, 80/80).
#
# This image is built at DEPLOY time (wrangler `image = ./containers/moq/Dockerfile`); the PR gate runs
# `wrangler deploy --dry-run` and does not build it.
FROM node:24-slim

WORKDIR /app
# Just the two proven files. No package.json / npm install — the strand has no dependencies.
COPY moq-strand.mjs server.mjs ./

# Bridge HTTP control plane (Worker reaches this via the CF Container binding). No public UDP — the
# only network egress is the outbound WSS to the relay, which is what makes MoQ hostable here.
EXPOSE 8080/tcp
ENV PORT=8080
# Drop privileges: run as the built-in non-root `node` user (uid 1000). 8080 is non-privileged, the
# strand writes nothing to disk, and child `node` processes inherit this user — so root is never needed.
USER node
ENTRYPOINT ["node", "server.mjs"]
