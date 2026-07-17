# Multi-stage build: compile a static binary, ship it on a tiny base image.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/taskflow-api .

FROM alpine:3.20
COPY --from=build /out/taskflow-api /taskflow-api
EXPOSE 8080
ENTRYPOINT ["/taskflow-api"]
