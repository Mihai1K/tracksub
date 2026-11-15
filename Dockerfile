# Ноль внешних зависимостей: образ маленький и собирается за секунды.
FROM node:24-alpine

WORKDIR /app

# Только то, что нужно в рантайме
COPY package.json ./
COPY src ./src
COPY fixtures ./fixtures
COPY tools ./tools
COPY docs ./docs

# Код принадлежит root и недоступен приложению на запись: пишем только в /app/data.
RUN mkdir -p /app/data /app/backups \
 && addgroup -S app && adduser -S app -G app \
 && chown -R root:root /app \
 && chown -R app:app /app/data /app/backups
USER app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
