FROM python:3.13-slim@sha256:6771159cd4fa5d9bba1258caf0b82e6b73458c694d178ad97c5e925c2d0e1a91

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PORT=8080

WORKDIR /service

RUN groupadd --system optimizer \
    && useradd --system --gid optimizer --home-dir /nonexistent optimizer

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY optimizer_service ./optimizer_service

USER optimizer

EXPOSE 8080

CMD ["sh", "-c", "uvicorn optimizer_service.main:app --host 0.0.0.0 --port \"${PORT}\" --no-access-log --proxy-headers --forwarded-allow-ips=\"${TRUSTED_PROXY_IPS:-127.0.0.1}\""]
