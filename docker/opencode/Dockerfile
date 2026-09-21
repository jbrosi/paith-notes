FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    curl git unzip ca-certificates software-properties-common ssh-client \
    jq ripgrep \
    python3 python3-pip python3-yaml \
    ffmpeg \
    && add-apt-repository ppa:ondrej/php \
    && apt-get update && apt-get install -y \
    php8.5-cli php8.5-pgsql php8.5-mbstring php8.5-xml php8.5-curl \
    php8.5-pcov php8.5-zip php8.5-gd \
    && rm -rf /var/lib/apt/lists/*

# Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Node 24
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Yarn via corepack
RUN corepack enable

# opencode CLI
RUN npm install -g opencode-ai

# Entry wrapper (state dirs)
COPY docker/opencode/oc-entry.sh /usr/local/bin/oc-entry.sh
RUN chmod +x /usr/local/bin/oc-entry.sh

WORKDIR /app
