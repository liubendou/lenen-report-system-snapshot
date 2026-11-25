# 乐恩报道管理系统 · 零依赖 Node 应用，无需 npm install
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai
RUN apk add --no-cache tzdata
COPY server.js backup.js ./
COPY lib ./lib
COPY public ./public
EXPOSE 8800
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8800/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
