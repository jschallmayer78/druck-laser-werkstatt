FROM python:3.12-slim

# Hintergrund entfernen für die Lasergravur (rembg + Modell, ca. 400 MB mehr im Image).
# Abschalten mit:  docker compose build --build-arg WITH_BG_REMOVAL=0
ARG WITH_BG_REMOVAL=1
ARG BG_MODEL=isnet-general-use

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 JOB_DIR=/data \
    U2NET_HOME=/opt/u2net BG_MODEL=${BG_MODEL} NUMBA_CACHE_DIR=/tmp/numba-cache
WORKDIR /srv
COPY requirements.txt requirements-bg.txt ./
RUN pip install --no-cache-dir -r requirements.txt
RUN if [ "$WITH_BG_REMOVAL" = "1" ]; then \
      pip install --no-cache-dir -r requirements-bg.txt && \
      python -c "from rembg import new_session; new_session('${BG_MODEL}')" && \
      chmod -R a+rX /opt/u2net; \
    fi
COPY app ./app
RUN useradd -r -u 1000 litho && mkdir -p /data /tmp/numba-cache && chown litho /data && chown -R litho /tmp/numba-cache
USER litho

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers"]
