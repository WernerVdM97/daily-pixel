FROM debian:12

RUN apt update && apt install -y nodejs npm git curl && \
    useradd -m bot

USER bot
WORKDIR /home/bot/app

COPY package*.json ./
RUN npm install

COPY . .

CMD ["npx", "tsx", "src/index.ts"]
