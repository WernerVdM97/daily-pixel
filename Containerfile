FROM debian:12

RUN apt update && apt install -y curl git ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt install -y nodejs && \
    useradd -m bot

USER bot
WORKDIR /home/bot/app

COPY package*.json ./
RUN npm ci

COPY . .

CMD ["npx", "tsx", "src/index.ts"]
