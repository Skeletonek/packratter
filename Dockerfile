# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.22.2

# --- builder ---------------------------------------------------------------
FROM registry.fedoraproject.org/fedora:44 AS builder
ARG NODE_VERSION
RUN dnf -y install python3 make gcc-c++ curl xz \
 && dnf clean all

RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1 --exclude='share/*'

RUN corepack enable

WORKDIR /build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm prune --prod

# --- runtime ---------------------------------------------------------------
FROM registry.fedoraproject.org/fedora:44
ARG NODE_VERSION
RUN dnf -y install createrepo_c dpkg-devel ostree flatpak gnupg2 zstd tar xz \
      bsdtar pacman apt-utils curl findutils \
 && dnf clean all

RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
  | tar -xJ -C /usr/local --strip-components=1 --exclude='share/*'

# The service runs unprivileged. uid/gid 1000 matches the usual first host
# user, so bind-mounted data directories keep working without chowning.
RUN useradd --uid 1000 --user-group --shell /sbin/nologin packratter

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/docker-entrypoint.sh ./docker-entrypoint.sh

VOLUME /data
EXPOSE 8080
ENV NODE_ENV=production
# Starts as root so the entrypoint can republish /data ownership, then drops
# to the unprivileged packratter user for the server process itself.
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
