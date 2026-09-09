FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS ui
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.test.json ./
COPY public ./public
COPY src ./src
RUN yarn build

FROM golang:1.27-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS server
WORKDIR /app
COPY go.mod main.go ./
COPY --from=ui /app/dist ./dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /pyrolens .

FROM gcr.io/distroless/static-debian12:nonroot@sha256:1b7b9f0f0e0a1d2155f531db587cc48ec26aaf97ab64364225f5bf18a054e66a
LABEL org.opencontainers.image.title="Pyrolens" \
      org.opencontainers.image.source="https://github.com/be-hase/pyrolens" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=server /pyrolens /pyrolens
# Same /licenses as the release image (Dockerfile.release): the minified UI
# bundle strips its license comments, so the attributions ride here.
COPY LICENSE THIRD-PARTY-NOTICES.md /licenses/
EXPOSE 4041
ENTRYPOINT ["/pyrolens"]
