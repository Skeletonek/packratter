# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.21.0

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

WORKDIR /app
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

VOLUME /data
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "/app/dist/index.js"]
