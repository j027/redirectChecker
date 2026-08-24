FROM node:24-bookworm

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      xvfb fluxbox x11vnc novnc websockify x11-utils && \
    rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

ENV TZ=America/New_York

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libxkbcommon0 \
      libasound2 libgbm1 libatspi2.0-0 fonts-liberation tzdata && \
    rm -rf /var/lib/apt/lists/*

RUN npx patchright install chromium

COPY docker/entrypoint.sh /app/docker/entrypoint.sh

USER node

ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["sh", "-c", "yarn build && exec node dist/discordBot.js"]
