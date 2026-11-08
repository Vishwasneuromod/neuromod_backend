FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js lambda.js ./
COPY src ./src
USER node
EXPOSE 8787
CMD ["node", "server.js"]
