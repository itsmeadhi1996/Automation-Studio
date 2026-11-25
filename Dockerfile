# Playwright's image carries Chromium, Firefox, their system libraries and Xvfb.
# Keep its version equal to the playwright version in package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
  # The seed test and the default project browser use Google Chrome.
  && npx playwright install chrome \
  && npm cache clean --force

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    STUDIO_STORAGE_DIR=/var/data

EXPOSE 10000

CMD ["sh", "scripts/docker-start.sh"]
