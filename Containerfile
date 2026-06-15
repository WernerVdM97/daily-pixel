FROM debian:12

RUN apt update && apt install -y curl git ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt install -y nodejs

WORKDIR /app
COPY package*.json ./
RUN npm install

RUN useradd -m bot
COPY --chown=bot:bot . .

USER bot

CMD ["npx", "tsx", "src/index.ts"]
