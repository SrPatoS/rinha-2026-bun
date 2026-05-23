FROM oven/bun:1.2.15-alpine

WORKDIR /app

COPY package.json .
COPY src ./src
COPY resources/references.bin /app/resources/references.bin

ENV PORT=8080
ENV REFERENCES_PATH=/app/resources/references.bin
ENV MAX_REFERENCES=0
ENV CANDIDATE_LIMIT=125
ENV WORKERS=1

CMD ["bun", "src/server.js"]
