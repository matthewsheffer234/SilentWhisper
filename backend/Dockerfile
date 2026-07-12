# Build context is the repo root (not /backend) so this image can also
# include /database — knexfile.js's migrations directory (../database/migrations)
# resolves the same way inside the container as it does on the host. See
# docker-compose.yml: build.context is "." with dockerfile "backend/Dockerfile".
FROM node:20-alpine

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/ ./
COPY database/ /app/database/

EXPOSE 8000

CMD ["node", "src/index.js"]
