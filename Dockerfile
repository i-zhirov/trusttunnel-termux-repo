FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      binutils \
      ca-certificates \
      curl \
      dpkg \
      gnupg \
      python3 \
      xz-utils \
 && rm -rf /var/lib/apt/lists/*

FROM base AS test
COPY package.json ./
COPY versions.json ./
COPY scripts/ ./scripts/
RUN npm test

FROM base AS tools
COPY package.json ./
COPY versions.json ./
COPY scripts/ ./scripts/
CMD ["node", "scripts/build-repo.js"]
