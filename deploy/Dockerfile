FROM python:3.13-alpine

WORKDIR /app
COPY server.py /app/server.py
COPY site /app/site

RUN addgroup -S flasher && adduser -S -G flasher flasher
USER flasher

ENV PORT=8080 SITE_DIR=/app/site PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["python", "/app/server.py"]
