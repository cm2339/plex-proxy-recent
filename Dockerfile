FROM node:20-alpine

# Run as non-root user
RUN addgroup -S proxy && adduser -S proxy -G proxy

WORKDIR /app
COPY server.js .

# Lock down file ownership
RUN chown -R proxy:proxy /app

USER proxy

EXPOSE 3001
CMD ["node", "server.js"]
