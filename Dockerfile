FROM node:24-alpine AS ui
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tsconfig.test.json ./
COPY public ./public
COPY src ./src
RUN yarn build

FROM golang:1.25-alpine AS server
WORKDIR /app
COPY go.mod main.go ./
COPY --from=ui /app/dist ./dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /pyrolens .

FROM gcr.io/distroless/static-debian12:nonroot
LABEL org.opencontainers.image.title="Pyrolens" \
      org.opencontainers.image.source="https://github.com/be-hase/pyrolens" \
      org.opencontainers.image.licenses="Apache-2.0"
COPY --from=server /pyrolens /pyrolens
EXPOSE 4041
ENTRYPOINT ["/pyrolens"]
