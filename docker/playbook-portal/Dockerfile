ARG NODE_IMAGE=node:23-alpine@sha256:abe653bbf1d1954001784771d5d14920cfb4905297b6ff914709ab032f25b45b
ARG NGINX_IMAGE=nginx:1.25-alpine@sha256:19b1b49aa68f1b632e1dd6e5efe7a2ca06b3f60c58adfe963d797f712717ebe6
FROM ${NODE_IMAGE} AS build

ARG PNPM_VERSION=11.24.0
WORKDIR /workspace/playbook-portal
COPY playbook-portal/package.json playbook-portal/pnpm-lock.yaml ./
RUN npm install --global "pnpm@${PNPM_VERSION}" \
  && pnpm install --frozen-lockfile --ignore-scripts

COPY playbook-portal/ ./
COPY docs/ai-delivery-playbook/ /workspace/docs/ai-delivery-playbook/
RUN pnpm run check

FROM ${NGINX_IMAGE} AS runtime

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Forge AI Delivery Playbook Portal" \
      org.opencontainers.image.description="Read-only VPN portal for the governed Forge Admin AI delivery playbook" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

COPY docker/playbook-portal/nginx.conf /etc/nginx/nginx.conf
COPY --from=build --chown=101:101 /workspace/playbook-portal/dist/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
