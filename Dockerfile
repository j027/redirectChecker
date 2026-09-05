FROM node:24-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify x11-utils curl && \
    rm -rf /var/lib/apt/lists/*

ENV TZ=America/New_York

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 \
      libasound2 libgbm1 libatspi2.0-0 fonts-liberation tzdata && \
    rm -rf /var/lib/apt/lists/*

# Google Chrome (rolling stable) for the image architecture.
# The .deb name follows the target architecture so the same
# Dockerfile builds on ARM and x86 machines.
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then CHROME_DEB="google-chrome-stable_current_arm64.deb"; else CHROME_DEB="google-chrome-stable_current_amd64.deb"; fi && \
    curl -fsSLO "https://dl.google.com/linux/direct/${CHROME_DEB}" && \
    apt-get update && \
    apt-get install -y --no-install-recommends "./${CHROME_DEB}" && \
    rm -f "./${CHROME_DEB}" && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/opt/chrome/policies/managed && \
    printf '%s' '{"SafeBrowsingEnabled": false}' > /etc/opt/chrome/policies/managed/safe_browsing.json

COPY docker/entrypoint.sh /app/docker/entrypoint.sh

USER node

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["sh", "-c", "yarn build && exec node dist/discordBot.js"]
