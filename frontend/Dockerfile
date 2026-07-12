# Dev-server container, matching ~/wireservice-dev/frontend's pattern: code
# is baked into the image at build time (no source volume mount), and the
# Vite dev server runs inside the container. Rebuild after source changes
# (see RUNBOOK.md).
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "run", "dev"]
