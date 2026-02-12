FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# Use China mirror for apt packages
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
 && sed -i 's|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources

# System dependencies:
# - python3/pip: Python tools runtime
# - tini: signal handling for long-running bot process
# - libfuse2 + X libs: optional support for ODA AppImage in container
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    pkg-config \
    libxml2-dev \
    libxslt1-dev \
    zlib1g-dev \
    libjpeg62-turbo-dev \
    libpng-dev \
    libfreetype6-dev \
    ca-certificates \
    tini \
    libfuse2 \
    libglib2.0-0 \
    libsm6 \
    libxrender1 \
    libxext6 \
    libx11-6 \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies first for layer cache
COPY package*.json ./
RUN npm ci

# Install Python dependencies
COPY requirements.txt ./requirements.txt
COPY tools/python/requirements.txt ./tools/python/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages --upgrade pip setuptools wheel \
  && pip3 install --no-cache-dir --break-system-packages -r tools/python/requirements.txt

# Copy source and build
COPY . .
RUN npm run build \
  && npm prune --omit=dev

# Runtime directories (will typically be bind-mounted per tenant)
RUN mkdir -p \
    /app/files \
    /app/logs \
    /app/workspace \
    /app/extracted \
    /app/docs/analysis \
    /app/docs/runs \
    /app/docs/ppt \
    /app/audit

COPY deploy/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  && useradd -m -u 10001 -s /bin/bash xiaoba \
  && mkdir -p /home/xiaoba/.xiaoba \
  && chown -R xiaoba:xiaoba /app /entrypoint.sh /home/xiaoba

USER xiaoba

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
CMD ["node", "dist/index.js", "feishu"]
