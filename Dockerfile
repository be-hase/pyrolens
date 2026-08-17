FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS ui
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.test.json ./
COPY public ./public
COPY src ./src
RUN yarn build

FROM golang:1.26-alpine@sha256:70b46548e42db77e0966aaf3619fd068734dc6c77584d526b91126504fd95816 AS server
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
