FROM ubuntu:22.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends srt-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["srt-live-transmit"]
