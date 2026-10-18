# Supply an already verified, locally available runtime tag or repository digest.
# Do not use a bare sha256 image ID in FROM; bind it to a local tag first.
ARG PRODUCTION_RUNTIME_BASE_IMAGE
FROM ${PRODUCTION_RUNTIME_BASE_IMAGE}
ARG SOURCE_REVISION
USER 0:0
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
WORKDIR /tmp
# The inspected parent already supplies Node and Git. Install only missing
# Python/Docker tools; no daemon is started in this service or during the build.
RUN set -eu; \
    packages=""; \
    command -v python3 >/dev/null 2>&1 || packages="${packages} python3"; \
    command -v docker >/dev/null 2>&1 || packages="${packages} docker.io"; \
    if [ -n "${packages}" ]; then \
      command -v apt-get >/dev/null; \
      if grep -q '^URIs: https://snapshot.ubuntu.com/' /etc/apt/sources.list.d/ubuntu.sources; then \
        . /etc/os-release; \
        test "${ID}" = ubuntu; test "${VERSION_CODENAME}" = noble; \
        grep -Fq 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' /etc/apt/sources.list.d/ubuntu.sources; \
        cp /etc/apt/sources.list.d/ubuntu.sources /usr/local/share/production-parent-ubuntu.sources; \
        printf '%s\n' 'Types: deb' 'URIs: https://archive.ubuntu.com/ubuntu/' 'Suites: noble noble-updates' 'Components: main universe' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' '' 'Types: deb' 'URIs: https://security.ubuntu.com/ubuntu/' 'Suites: noble-security' 'Components: main universe' 'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' > /etc/apt/sources.list.d/ubuntu.sources; \
      fi; \
      temporary_policy=0; \
      if [ ! -e /usr/sbin/policy-rc.d ]; then \
        printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; \
        chmod 0755 /usr/sbin/policy-rc.d; temporary_policy=1; \
      fi; \
      apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o APT::Update::Error-Mode=any update; \
      DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install -y --no-install-recommends ${packages}; \
      if [ "${temporary_policy}" = 1 ]; then rm /usr/sbin/policy-rc.d; fi; \
    fi
COPY --chmod=0644 docker/harness/production-delivery-store.mjs docker/harness/production-delivery-service.mjs docker/harness/production-delivery-client.mjs /usr/local/lib/
COPY --chmod=0755 scripts/production_delivery_worker.py scripts/production_delivery_deploy.py /usr/local/lib/forge-production/
# Verify the actual final consumer without network or npm/pip dependencies.
RUN --network=none node --version \
    && python3 --version \
    && git --version \
    && docker --version \
    && node --check /usr/local/lib/production-delivery-store.mjs \
    && node --check /usr/local/lib/production-delivery-service.mjs \
    && node --check /usr/local/lib/production-delivery-client.mjs \
    && python3 -c 'import ast,pathlib; [ast.parse(p.read_text()) for p in pathlib.Path("/usr/local/lib/forge-production").glob("*.py")]' \
    && test -n "${SOURCE_REVISION}"
LABEL org.opencontainers.image.title="Forge production delivery service" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      com.forge-delivery.runtime-role="production-delivery"
ENTRYPOINT []
CMD ["node", "/usr/local/lib/production-delivery-service.mjs"]
