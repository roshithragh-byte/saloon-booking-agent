FROM node:20-slim

WORKDIR /app

# Install dependencies first for efficient caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Set default port
ENV PORT=8080
EXPOSE 8080

CMD ["node", "app.js"]
