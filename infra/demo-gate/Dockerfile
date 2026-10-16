# The demo gate: Node (no packages) + the docker CLI, to start and stop the demo containers on this server.
FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose
WORKDIR /gate
COPY gate.mjs logo.png ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/__demo/health || exit 1
CMD ["node", "gate.mjs"]
